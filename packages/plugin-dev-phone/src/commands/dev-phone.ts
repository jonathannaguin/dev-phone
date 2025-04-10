import path from 'path';
import fs from 'fs';
import open from 'open';
import express from 'express';
import confirm from '@inquirer/confirm';

import { Flags } from '@oclif/core';
import { deployServerless, constants } from '../utils/create-serverless-util';
import { getAvailablePort, isValidPort } from '../utils/helpers'
import { isSmsUrlSet, isVoiceUrlSet, updatePhoneWebhooks, removePhoneWebhooks } from '../utils/phone-number-utils';
const { TwilioClientCommand } = require('@twilio/cli-core').baseCommands;
const { TwilioCliError } = require('@twilio/cli-core').services.error;
const WebClientPath = path.resolve(require.resolve('@twilio-labs/dev-phone-ui'), '..')
const { version } = require('../../package.json');

// Types
import { ServiceInstance as ServerlessServiceInstance } from 'twilio/lib/rest/serverless/v1/service'
import { ServiceInstance as SyncServiceInstance } from 'twilio/lib/rest/sync/v1/service'
import { KeyInstance } from 'twilio/lib/rest/api/v2010/account/key'
import { ApplicationInstance } from 'twilio/lib/rest/api/v2010/account/application'
import { IncomingPhoneNumberInstance } from 'twilio/lib/rest/api/v2010/account/incomingPhoneNumber'

const AccessToken = require('twilio').jwt.AccessToken;
const ChatGrant = AccessToken.ChatGrant;
const VoiceGrant = AccessToken.VoiceGrant;
const SyncGrant = AccessToken.SyncGrant;
const CALL_LOG_MAP_NAME = 'CallLog'

// removes unecessary properties to standardize the twilio phone number
const reformatTwilioPns = (twilioResponse: IncomingPhoneNumberInstance[]) => {
    return {
        "phone-numbers": twilioResponse.map(
            ({ phoneNumber, friendlyName, smsUrl, voiceUrl, sid }) =>
                ({ phoneNumber, friendlyName, smsUrl, voiceUrl, sid }))
    }
}

const generateRandomPhoneName = () => {
    let rand = Math.random().toString().substring(2, 6)
    return `dev-phone-${rand}`;
}

class DevPhoneServer extends TwilioClientCommand {
    constructor(argv: any, config: any, secureStorage: any) {
        super(argv, config, secureStorage);
        this.cliSettings = {};
        this.pns = [];
        this.port = 1337
        this.jwt = null;
        this.apikey = {};
        this.twimlApp = {};
        this.devPhoneName = generateRandomPhoneName();
        this.voiceUrl = null;
        this.smsUrl = null;
        this.voiceOutboundUrl = null;
    }

    async run() {
        await super.run();

        const props = this.parseProperties() || {};
        await this.validatePropsAndFlags(props, this.flags)

        console.log(`Hello 👋 I'm your dev-phone and my name is ${this.devPhoneName}\n`)

        // set user agent header on twilio client
        this.twilioClient.userAgentExtensions = [
            `@twilio-labs/dev-phone/${version}`,
            `@twilio-labs/dev-phone/helper-library`,
            'serverless-functions'
        ]

        // create API KEY and API SECRET to be generate JWT AccessToken for ChatGrant, VoiceGrant and SyncGrant
        this.apikey = await this.reuseOrCreateApiKey();

        const isDeletingAll = () => !!this.flags.clear;

        const deleteAll = async () => {
          await this.destroyAllConversations();
          await this.destroyAllTwimlApps();
          await this.destroyAllApiKeys();
          await this.destroyAllSyncs();
          await this.destroyAllFunctions();
          await this.removeAllPhoneWebhooks();
        }

        if (isDeletingAll()) {
            const deleteAllConfirmation = await confirm({
                message: "Do you want to delete all of the dev phone resources on your Twilio account? This may interfere with other instances of the Dev Phone.",
                default: false
            })
            if(deleteAllConfirmation){
                console.log(`🌐 Deleting all dev-phone resources from your account before starting...`)
                await deleteAll().finally(() => console.log(`✅ All resources have been deleted.`));
            }
        }

        // create conversation for SMS/web interface
        this.conversation = await this.createConversation();

        // create Sync for Call History interface
        this.sync = await this.createSync();

        // create Function to handle inbound-voice, inbound-sms and outbound-voice (voip)
        this.serverless = await this.createFunction();

        // create TwiML App
        this.twimlApp = await this.createTwimlApp();

        // create JWT Access Token with ChatGrant, VoiceGrant and SyncGrant
        this.jwt = await this.createJwt();

        // add webhook config to the phone number, if there is one passed by CLI flag
        // TO-DO return updated phone number and set this.phoneNumber
        const phoneNumberProps =  {voiceUrl: this.voiceUrl, smsUrl: this.smsUrl, statusCallback: this.statusCallback}
        this.cliSettings.phoneNumber =  await updatePhoneWebhooks(this.cliSettings.phoneNumber,this.twilioClient.incomingPhoneNumbers, phoneNumberProps );

        const onShutdown = async () => {
            await this.destroyConversations();
            await this.destroyTwimlApps();
            await this.destroyApiKeys();
            await this.destroySyncs();
            await this.destroyFunction();
            await removePhoneWebhooks(this.cliSettings.phoneNumber, this.twilioClient.incomingPhoneNumbers);
        }

        process.on("SIGTERM", async function () {
            console.log("\n👋 Shutting down");
            await onShutdown().finally(() => process.exit(0));
        });

        process.on('SIGINT', async function () {
            console.log("\n👋 Shutting down");
            await onShutdown().finally(() => process.exit(0));
        });

        const app = express();

        // serve assets from the "public" directory
        // __dirname is the path to _this_ file, so ../../public to find index.html
        app.use(express.static(WebClientPath));

        app.use(express.json()); // response body writer

        app.get("/ping", (req, res) => {
            res.json({ pong: true });

            console.log('TWILIO', this.twilioClient);
        })

        app.get("/plugin-settings", (req, res) => {
            res.json({
                ...this.cliSettings,
                devPhoneName: this.devPhoneName,
                conversation: this.conversation
            });
        })

        app.get("/phone-numbers", async (req: express.Request, res: express.Response) => {
            if (this.pns.length === 0) {
                try {
                    const pns = await this.twilioClient.incomingPhoneNumbers.list()
                    this.pns = pns
                    res.json(reformatTwilioPns(pns))
                } catch (err: any) {
                    console.error('Phone number API threw an error', err);
                    res.status(err.status ? err.status : 400).send({ error: err })
                }
            } else {
                res.json(reformatTwilioPns(this.pns));
            }
        })

        app.post("/send-sms", async (req:express.Request, res:express.Response) => {
            const {body, from, to} = req.body
            try {
                const message = await this.twilioClient.messages
                    .create({
                        body,
                        from,
                        to
                    })
                res.json({result: message})
            } catch (err: any) {
                console.error('SMS API threw an error', err);
                res.status(err.status ? err.status : 400).send({ error: err });
            };
        })

        app.all("/choose-phone-number", async (req:express.Request, res:express.Response) => {
            try {
                const rawNumbers = await this.twilioClient.incomingPhoneNumbers
                    .list({ phoneNumber: req.body.phoneNumber, limit: 20 })
                const selectedNumber = reformatTwilioPns(rawNumbers)["phone-numbers"];

                // Should only have a single number
                if (selectedNumber.length === 1) {
                    await removePhoneWebhooks(this.cliSettings.phoneNumber, this.twilioClient.incomingPhoneNumbers);
                    this.cliSettings.phoneNumber = selectedNumber[0];
                    this.cliSettings.phoneNumber = await updatePhoneWebhooks(this.cliSettings.phoneNumber,this.twilioClient.incomingPhoneNumbers, {voiceUrl: this.voiceUrl, smsUrl: this.smsUrl, statusCallback: this.statusCallback} );
                    res.json({
                        phoneNumber: this.cliSettings.phoneNumber,
                        message: 'Phone number updated!'
                    });
                } else {
                    console.error('Phone number not found!');
                    res.status(400).send({
                        message: 'Phone number not found!'
                    });
                }
            } catch (err) {
                console.error(err)
                res.status(400).send(err);
            }
        })

        app.get("/client-token", async (req:express.Request, res:express.Response) => {
            try {
                if (!this.jwt) {
                    this.jwt = await this.createJwt();
                }

                res.json({ token: this.jwt });
            } catch (err) {
                res.status(400).send(err)
            }
        })

        const isHeadless = () => !!this.flags.headless;

        app.listen(this.port, () => {
            console.log(`🚀 Your local webserver is listening on port ${this.port}`);

            if (fs.existsSync(path.join(WebClientPath, 'index.html'))) {

                const uiUrl = `http://localhost:${this.port}/`

                if (isHeadless()) {
                    console.log(`🌐 UI is available at ${uiUrl}`)
                } else {
                    console.log(`🌐 Opening ${uiUrl} your browser`);
                    open(uiUrl);
                }

            } else {
                console.log('Hello friend! Front end files are missing, ie you are developing this pluign.');
                console.log('Run: `cd plugin-dev-phone-client` then `npm start` to run dev front-end')
                console.log('To build the front-end so that the local backend will serve it: ./build-for-release.sh')
            }

            console.log('▶️  Use ctrl-c to stop your dev-phone\n');
        });
    }

    async createFunction() {
        console.log('💻 Deploying a Functions Service to handle incoming calls and SMS...');
        const deployedFunctions = await deployServerless({
            username: this.twilioClient.username,
            password: this.twilioClient.password,
            env: {
                SYNC_SERVICE_SID: this.sync.sid,
                CONVERSATION_SID: this.conversation.sid,
                CONVERSATION_SERVICE_SID: this.conversation.serviceSid,
                DEV_PHONE_NAME: this.devPhoneName,
                DEV_PHONE_VERSION: version,
                CALL_LOG_MAP_NAME
            },
            onUpdate: (event) => {
                const isBuildStatusPing = event.message.indexOf('Current status: building') > -1
                const settingEnvVars = event.message.indexOf('environment variables') > -1
                if(isBuildStatusPing || event.status === 'building') {
                    isBuildStatusPing ? process.stdout.write('.') : process.stdout.write(`🛠 ${event.message}`)
                } else {
                    console.log(`${settingEnvVars ? '\n' : ''}🧑‍💻 ${event.message}`)
                }
            }
        });

        console.log(`✅ I'm using the Serverless Service ${deployedFunctions.serviceSid}\n`);

        this.voiceUrl = `https://${deployedFunctions.domain}/${constants.INCOMING_CALL_HANDLER}`
        this.voiceOutboundUrl = `https://${deployedFunctions.domain}/${constants.OUTBOUND_CALL_HANDLER}`
        this.smsUrl = `https://${deployedFunctions.domain}/${constants.INCOMING_MESSAGE_HANDLER}`
        this.statusCallback = `https://${deployedFunctions.domain}/${constants.SYNC_CALL_HISTORY}`

        return deployedFunctions;
    }

    async destroyFunction() {
        try {
            const functionServices = await this.twilioClient.serverless.services.list()
            const devPhoneFunctionServices = functionServices.filter((functionServices: ServerlessServiceInstance) => {
            return functionServices.friendlyName !== null && functionServices.friendlyName.startsWith(this.devPhoneName)
          })

          if(devPhoneFunctionServices.length > 0) {
              console.log(`🚮 Removing Serverless Functions for ${this.devPhoneName}`);

              for (const functionService of devPhoneFunctionServices) {
                await this.twilioClient.serverless.services(functionService.sid)
                  .remove();
              }
          }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllFunctions() {
        try {
            const functionServices = await this.twilioClient.serverless.services.list()
            const devPhoneFunctionServices = functionServices.filter((functionServices: ServerlessServiceInstance) => {
            return functionServices.friendlyName !== null && functionServices.friendlyName.startsWith('dev-phone')
        })

        if(devPhoneFunctionServices.length > 0) {
            console.log(`🚮 Removing All Serverless Functions for existing dev phone`);
            for (const functionService of devPhoneFunctionServices) {
                await this.twilioClient.serverless.v1.services(functionService.sid)
                        .remove();
            }
        }
        } catch (err) {
            console.error(err)
        }
    }


    async validatePropsAndFlags(props: any, flags: any) {
        // Flags defined below can be validated and used here. Example:
        // https://github.com/twilio/plugin-debugger/blob/main/src/commands/debugger/logs/list.js#L46-L56

        this.cliSettings.forceMode = flags['force'];
        this.port = process.env.TWILIO_DEV_PHONE_PORT || await getAvailablePort();
        if (flags['phone-number']) {
            const phoneNumber = await flags['phone-number']
            this.pns = await this.twilioClient.incomingPhoneNumbers
                .list({ phoneNumber: phoneNumber });

            if (this.pns.length < 1) {
                throw new TwilioCliError(
                    `The phone number ${phoneNumber} is not associated with your Twilio account`
                );
            }

            const pnConfigAlreadySet = [
                (isSmsUrlSet(this.pns[0].smsUrl) ? "SMS webhook URL" : null),
                (isVoiceUrlSet(this.pns[0].voiceUrl) ? "Voice webhook URL" : null),
            ].filter(x => x);

            if (pnConfigAlreadySet.length > 0 && !this.cliSettings.forceMode) {
                throw new TwilioCliError(
                    `Cannot use ${phoneNumber} because the following config for that phone number would be overwritten: ` + pnConfigAlreadySet.join(", ")
                );
            }

            this.cliSettings.phoneNumber = reformatTwilioPns(this.pns)["phone-numbers"][0];

        }

        if(flags['port']) {
            const port = await flags['port']
            try {
                if(isValidPort(port)){
                    this.port = parseInt(port)
                } else {
                    throw new TwilioCliError(
                        `❗️ '${port}' is not a valid port. 😳 I'll try to get set up with ${this.port} instead.`,
                        )
                }
            } catch (err:any) {
                console.error(err.message)
            }
        }
    }

    twilioCliIsConfiguredWithApiKey() {
        return this.currentProfile.apiKey.startsWith("SK");
    }

    async reuseOrCreateApiKey() {

        // We need an API KEY and SECRET to create the Access Token
        // Depending on how the user has provided the CLI with creds
        // we may have one already in this.currentProfile, or we may
        // need to create a new one

        if (this.twilioCliIsConfiguredWithApiKey()) {
            // This case is if the user has _not_ used env vars for
            // their creds. Here we can reuse the api keys and secret
            // that the CLI created when it was installed

            console.log("✅ I'm using your profile API key.\n");
            return {
                sid: this.currentProfile.apiKey,
                secret: this.currentProfile.apiSecret
            }

        } else {
            // This case is if the user has started the CLI with
            // $TWILIO_ACCOUNT_SID and $TWILIO_AUTH_TOKEN set in
            // their environment, using their account creds but
            // their API_KEY and SECRET are not properly set.
            // the CLI uses the ACCOUNT_SID into currentProfile.apiKey
            // and we need to generate another key

            console.log("💻 I'm creating a new API Key...");
            await this.destroyApiKeys()
            try {
                const key = await this.twilioClient.newKeys.create({ friendlyName: this.devPhoneName });
                console.log(`✅ I'm using the API Key ${key.sid}\n`);

                this.currentProfile.apiKey = key.sid;
                this.currentProfile.apiSecret = key.secret;
                return {
                    sid: this.currentProfile.apiKey,
                    secret: this.currentProfile.apiSecret
                }
            } catch (err) {
                console.error(err)
            }
        }
    }

    async destroyApiKeys() {

        if (this.twilioCliIsConfiguredWithApiKey()) {
            // we never created one
            return
        } else {
            try {
                const keys = await this.twilioClient.keys.list()
                const devPhoneKeys = keys.filter((key: KeyInstance) => {
                    return key.friendlyName !== null && key.friendlyName.startsWith(this.devPhoneName)
                })

                if(devPhoneKeys.length > 0) {
                    console.log(`🚮 Removing API Keys for ${this.devPhoneName}`);
                    for (const key of devPhoneKeys) {
                        await this.twilioClient.keys(key.sid).remove();
                    }
                }
            } catch (err) {
                console.error(err)
            }
        }
    }

    async destroyAllApiKeys() {

        if (this.twilioCliIsConfiguredWithApiKey()) {
            // we never created one
            return
        } else {
            try {
                const keys = await this.twilioClient.keys.list()
                const devPhoneKeys = keys.filter((key: KeyInstance) => {
                    return key.friendlyName !== null && key.friendlyName.startsWith('dev-phone')
                })

                if(devPhoneKeys.length > 0) {
                    console.log(`🚮 Removing All API Keys for existing dev phone`);
                    for (const key of devPhoneKeys) {
                        await this.twilioClient.keys(key.sid).remove();
                    }
                }
            } catch (err) {
                console.error(err)
            }
        }
    }

    async createTwimlApp() {
        console.log('💻 Creating a new TwiMl App to allow voice calls from your browser...');
        await this.destroyTwimlApps()
        try {
            const app = await this.twilioClient.applications
                .create({
                    voiceUrl: this.voiceOutboundUrl,
                    friendlyName: this.devPhoneName
                });
            console.log(`✅ I'm using the TwiMl App ${app.sid}\n`);
            return app;
        } catch (err) {
            console.error(err)
        }
    }

    async destroyTwimlApps() {
        try {
            const applications = await this.twilioClient.applications.list()
            const devPhoneApps = applications.filter((twimlApp: ApplicationInstance) => {
                return twimlApp.friendlyName !== null && twimlApp.friendlyName.startsWith(this.devPhoneName)
            })

            if(devPhoneApps.length > 0) {
                console.log(`🚮 Removing TwiML app for ${this.devPhoneName}`);
                for (const twimlApp of devPhoneApps) {
                    await this.twilioClient.applications(twimlApp.sid)
                        .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllTwimlApps() {
        try {
            const applications = await this.twilioClient.applications.list()
            const devPhoneApps = applications.filter((twimlApp: ApplicationInstance) => {
                return twimlApp.friendlyName !== null && twimlApp.friendlyName.startsWith('dev-phone')
            })

            if(devPhoneApps.length > 0) {
                console.log(`🚮 Removing All TwiML app for existing dev phone`);
                for (const twimlApp of devPhoneApps) {
                    await this.twilioClient.applications(twimlApp.sid)
                        .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async createJwt() {

        const chatGrant = new ChatGrant({
            serviceSid: this.conversation.serviceSid
        });

        const voiceGrant = new VoiceGrant({
            incomingAllow: true,
            outgoingApplicationSid: this.twimlApp.sid
        });

        const syncGrant = new SyncGrant({
            serviceSid: this.sync.sid,
        })

        const token = new AccessToken(
            this.twilioClient.accountSid,
            this.apikey.sid,
            this.apikey.secret,
            {
                identity: this.devPhoneName,
                ttl: 24*60*60
            }
        );

        token.addGrant(chatGrant);
        token.addGrant(voiceGrant);
        token.addGrant(syncGrant);
        return token.toJwt();
    }

    async createSync() {
        console.log('💻 Creating a new sync list for call history...');
        await this.destroySyncs()

        try {
            const syncService = await this.twilioClient.sync.services
                .create({ friendlyName: this.devPhoneName });
            console.log(`✅ I'm using the sync service ${syncService.sid}\n`);
            // create 'CallLog' syncMap
            await this.twilioClient.sync.services(syncService.sid).syncMaps.create({
                uniqueName: CALL_LOG_MAP_NAME,
            });
            return syncService
        } catch (err) {
            console.error(err)
        }
    }

    async destroySyncs() {
        try {
            const syncServices = await this.twilioClient.sync.services.list()
            const devPhoneSyncServices = syncServices.filter((syncService: SyncServiceInstance) => {
                return syncService.friendlyName !== null && syncService.friendlyName.startsWith(this.devPhoneName)
            })

            if(devPhoneSyncServices.length > 0) {
                console.log(`🚮 Removing Sync Service for ${this.devPhoneName}`);
                for (const syncService of devPhoneSyncServices) {
                    await this.twilioClient.sync.services(syncService.sid)
                            .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllSyncs() {
        try {
            const syncServices = await this.twilioClient.sync.services.list()
            const devPhoneSyncServices = syncServices.filter((syncService: SyncServiceInstance) => {
                return syncService.friendlyName !== null && syncService.friendlyName.startsWith('dev-phone')
            })

            if(devPhoneSyncServices.length > 0) {
                console.log(`🚮 Removing All Sync Service for existing dev phone`);
                for (const syncService of devPhoneSyncServices) {
                    await this.twilioClient.sync.services(syncService.sid)
                            .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    // Creates a new conversation service, a conversation, and makes the dev phone a participant
    async createConversation() {
        await this.destroyConversations()
        console.log('💻 Creating a new conversation...');
        try {
            const service = await this.twilioClient.conversations.services
                .create({ friendlyName: this.devPhoneName });
            const conversationService = this.twilioClient.conversations.services(service.sid)
            const newConversation = await conversationService.conversations.create({ friendlyName: this.devPhoneName })
            await conversationService.conversations(newConversation.sid)
                .participants.create({identity: this.devPhoneName})
            console.log(`✅ I'm using the conversation ${newConversation.sid} from service ${service.sid}\n`);
            return {
                serviceSid: service.sid,
                sid: newConversation.sid
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyConversations() {
        try {
            const convoServices = await this.twilioClient.conversations.services.list()
            const devPhoneConvoServices = convoServices.filter((convoService: SyncServiceInstance) => {
                return convoService.friendlyName !== null && convoService.friendlyName.startsWith(this.devPhoneName)
            })

            if(devPhoneConvoServices.length > 0) {
                console.log(`🚮 Removing Conversation Service for ${this.devPhoneName}`);
                for (const convoService of devPhoneConvoServices) {
                    await this.twilioClient.conversations.services(convoService.sid)
                            .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async destroyAllConversations() {
        try {
            const convoServices = await this.twilioClient.conversations.services.list()
            const devPhoneConvoServices = convoServices.filter((convoService: SyncServiceInstance) => {
                return convoService.friendlyName !== null && convoService.friendlyName.startsWith('dev-phone')
            })

            if(devPhoneConvoServices.length > 0) {
                console.log(`🚮 Removing All Conversation Service for existing dev phone`);
                for (const convoService of devPhoneConvoServices) {
                    await this.twilioClient.conversations.services(convoService.sid)
                            .remove();
                }
            }
        } catch (err) {
            console.error(err)
        }
    }

    async removeAllPhoneWebhooks() {
        try {
            const pns = await this.twilioClient.incomingPhoneNumbers.list()

            const numbersDevPhone = pns.filter((pn: IncomingPhoneNumberInstance) => {
              return pn.smsUrl.startsWith('https://dev-phone') && pn.voiceUrl.startsWith('https://dev-phone')
            });

            if (numbersDevPhone.length > 0) {
              console.log(`🚮 Removing All number webhooks for dev phone`);
              for (const pn of numbersDevPhone) {
                await removePhoneWebhooks({
                  voiceUrl: '',
                  smsUrl: '',
                  statusCallback: '',
                  phoneNumber: pn.phoneNumber,
                  sid: pn.sid,
                }, this.twilioClient.incomingPhoneNumbers);
              }
            }
        } catch (err) {
            console.error(err)
        }
    }
}

DevPhoneServer.description = `Dev Phone local express server`

// Example of how to define flags and properties:
// https://github.com/twilio/plugin-debugger/blob/main/src/commands/debugger/logs/list.js#L99-L126
DevPhoneServer.PropertyFlags = {
    "phone-number": Flags.string({
        description: 'Optional. Associates the Dev Phone with a phone number. Takes a number from the active profile on the Twilio CLI as the parameter.'
    }),
    force: Flags.boolean({
        char: 'f',
        description: 'Optional. Forces an overwrite of the phone number configuration.',
        dependsOn: ['phone-number']
    }),
    headless: Flags.boolean({
        description: 'Optional. Prevents the UI from automatically opening in the browser.',
        default: false,
    }),
    clear: Flags.boolean({
        description: 'Optional. Remove all dev-phone resources from your account before starting the dev-phone.',
        default: false,
    }),
    port: Flags.string({
        description: 'Optional. Configures the port of the Dev Phone UI. Takes a valid port as a parameter.',
    })
};

DevPhoneServer.flags = Object.assign(
    DevPhoneServer.PropertyFlags,
    TwilioClientCommand.flags
);

module.exports = DevPhoneServer;
