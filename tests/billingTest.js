import assert from 'assert';
import uclusion from 'uclusion_sdk';
import TestTokenManager, {TOKEN_TYPE_ACCOUNT} from '../src/TestTokenManager';
import {getSSOInfo, loginUserToAccount, loginUserToMarket, getWebSocketRunner, getMessages} from '../src/utils';
import Stripe from 'stripe';
/*
Admin Configuration and User Configuration are used as in/out params here,
so that we don't have to keep making accounts for every seperate test
 */
module.exports = function (adminConfiguration, userConfiguration, stripeConfiguration) {
    const marketOptions = {
        name: 'Default',
        market_type: 'DECISION',
        expiration_minutes: 20
    };

    function createTestStripePayment(stripeClient) {
        const card = {
            "number": "4242424242424242",
            "exp_month": 11,
            "exp_year": 2039,
            "cvc": "314",
        };
        return stripeClient.paymentMethods.create({
            type: 'card',
            card
        });
    }

    describe('#Set up billing', () => {
        it('create a subscription without coupons', async () => {
            let adminAccountClient;
            const date = new Date();
            const timestamp = date.getTime();
            const accountName = 'TestAccount' + timestamp;
            let adminIdToken;
            let ssoClient;
            let createdMarketId;
            let adminClient;
            let hadPreviousSub = true;
            //first load stripe
            const stripeClient = new Stripe(stripeConfiguration.public_api_key, {apiVersion: '2020-08-27'});
            await getSSOInfo(adminConfiguration).then((ssoInfo) => {
                ssoClient = ssoInfo.ssoClient;
                adminIdToken = ssoInfo.idToken;
                return getWebSocketRunner(adminConfiguration);
            }).then((webSocketRunner) => {
                adminConfiguration.webSocketRunner = webSocketRunner;
                // make our client
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                adminAccountClient = client;
                return adminAccountClient.users.startSubscription('Standard');
            }).then((account) => {
                assert(account.billing_subscription_status === 'ACTIVE', 'Account did not subscribe');
                return adminAccountClient.users.update({'name': 'Default'});
            }).then(() => {
                //cancell our sub
                return adminAccountClient.users.cancelSubscription()
            }).then((account) => {
                assert(account.billing_subscription_status === 'CANCELED', 'Account still has subscription');
                // now restart subscribe without a promo code (the only tier we currently have is Standard)
                return createTestStripePayment(stripeClient)
                    .then((paymentInfo) => {
                        return adminAccountClient.users.restartSubscription(paymentInfo.id);
                    });
            }).then((account) => {
                assert(account.billing_subscription_status === 'ACTIVE', 'Account should have restarted subscription');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
        it('create a subscription with Test12Month coupon', async () => {
            const promoCode = 'Test12Month';
            let adminAccountClient;
            const date = new Date();
            const timestamp = date.getTime();
            const accountName = 'TestAccount' + timestamp;
            let adminIdToken;
            let ssoClient;
            let createdMarketId;
            let adminClient;
            let hadPreviousSub = true;
            //first load stripe
            const stripeClient = new Stripe(stripeConfiguration.public_api_key, {apiVersion: '2020-08-27'});
            await getSSOInfo(adminConfiguration).then((ssoInfo) => {
                ssoClient = ssoInfo.ssoClient;
                adminIdToken = ssoInfo.idToken;
                return getWebSocketRunner(adminConfiguration);
            }).then((webSocketRunner) => {
                adminConfiguration.webSocketRunner = webSocketRunner;
                // make our client
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                adminAccountClient = client;
                return adminAccountClient.users.startSubscription('Standard', undefined, promoCode);
            }).then((account) => {
                assert(account.billing_subscription_status === 'ACTIVE', 'Account did not subscribe');
                return adminAccountClient.users.update({'name': 'Default'});
            }).then(() => {
                //cancell our sub
                return adminAccountClient.users.cancelSubscription()
            }).then((account) => {
                assert(account.billing_subscription_status === 'CANCELED', 'Account still has subscription');
                // now restart subscribe without a promo code (the only tier we currently have is Standard)
                return createTestStripePayment(stripeClient)
                    .then((paymentInfo) => {
                        return adminAccountClient.users.restartSubscription(paymentInfo.id, promoCode);
                    });
            }).then((account) => {
                assert(account.billing_subscription_status === 'ACTIVE', 'Account should have restarted subscription');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
        it('Checks coupon validity', async () => {
            const validPromoCode = 'Test12Month';
            const invalidPromoCode = 'TestInvalid';
            let adminAccountClient;
            const date = new Date();
            const timestamp = date.getTime();
            const accountName = 'TestAccount' + timestamp;
            let adminIdToken;
            let ssoClient;
            let createdMarketId;
            let adminClient;
            let hadPreviousSub = true;
            //first load stripe
            const stripeClient = new Stripe(stripeConfiguration.public_api_key, {apiVersion: '2020-08-27'});
            await getSSOInfo(adminConfiguration).then((ssoInfo) => {
                ssoClient = ssoInfo.ssoClient;
                adminIdToken = ssoInfo.idToken;
                return getWebSocketRunner(adminConfiguration);
            }).then((webSocketRunner) => {
                adminConfiguration.webSocketRunner = webSocketRunner;
                // make our client
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                adminAccountClient = client;
                // first remove any existing subscriptions
                return adminAccountClient.users.validatePromoCode(validPromoCode);
            }).then((result) => {
                assert(result.valid, 'Promo Code should have been valid');
                return adminAccountClient.users.validatePromoCode(invalidPromoCode);
            }).then((result) => {
                assert(!result.valid, 'Promo code should have been invalid');
                return 'done';
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });


};
