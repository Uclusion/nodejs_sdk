import assert from 'assert';
import _ from 'lodash';
import uclusion from 'uclusion_sdk';
import TestTokenManager, {TOKEN_TYPE_ACCOUNT} from '../src/TestTokenManager';
import {getSSOInfo, loginUserToAccount, loginUserToMarket, getWebSocketRunner, getMessages} from '../src/utils';
import Stripe from 'stripe';
import {sleep} from "./commonTestFunctions";
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

    describe('#Test without coupons', () => {
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
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                // make our client
                adminAccountClient = client;
                return adminAccountClient.users.startSubscription('Standard');
            }).then((account) => {
                console.log(account);
                assert(account.billing_subscription_status === 'ACTIVE', 'Account did not subscribe');
                assert(account.tier === 'Standard', 'Should be standard tier');
                assert(new Date(account.billing_subscription_trial_end) > (Date.now() / 1000), 'Trial is in the past');
                //cancel our sub
                return adminAccountClient.users.cancelSubscription();
            }).then((account) => {
                assert(account.billing_subscription_status === 'CANCELED', 'Account still has subscription');
                assert(account.tier === 'Free', 'Should have been free tier');
                // now restart subscribe without a promo code (the only tier we currently have is Standard)
                return createTestStripePayment(stripeClient)
                    .then((paymentInfo) => {
                        return adminAccountClient.users.restartSubscription(paymentInfo.id);
                    });
            }).then((account) => {
                assert(account.billing_subscription_status === 'ACTIVE', 'Account should have restarted subscription');
                assert(account.tier === 'Standard')
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });
    describe('#Test coupons', () => {
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
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                //make our client
                adminAccountClient = client;
                return adminAccountClient.users.startSubscription('Standard', undefined, promoCode);
            }).then((account) => {
                //console.log(account)
                const {billing_promotions, billing_subscription_status} = account;
                assert(billing_subscription_status === 'ACTIVE', 'Account did not subscribe');
                assert(billing_promotions.length > 0, 'Should have had coupons')
                assert(billing_promotions[0].months === 12, 'should have been a 12 month coupon');
                assert(billing_promotions[0].consumed === false, 'should not have been used yet');
                //cancel our sub
                return adminAccountClient.users.cancelSubscription();
            }).then((account) => {
                assert(account.billing_subscription_status === 'CANCELED', 'Account still has subscription');
                // now restart subscribe without a promo code (the only tier we currently have is Standard)
                return createTestStripePayment(stripeClient)
                    .then((paymentInfo) => {
                        return adminAccountClient.users.restartSubscription(paymentInfo.id, promoCode);
                    });
            }).then((account) => {
                const {billing_promotions, billing_subscription_status} = account;
                assert(billing_subscription_status === 'ACTIVE', 'Account should have restarted subscription');
                assert(billing_promotions.length > 0, 'Should have had coupons')
                assert(billing_promotions[0].months === 12, 'should have been a 12 month coupon');
                assert(billing_promotions[0].consumed === false, 'should not have been used yet');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });
    describe('#Test coupon reset on restart', () => {
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
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                //make our client
                adminAccountClient = client;
                return adminAccountClient.users.startSubscription('Standard', undefined, promoCode);
            }).then((account) => {
                //console.log(account)
                const {billing_promotions, billing_subscription_status} = account;
                assert(billing_subscription_status === 'ACTIVE', 'Account did not subscribe');
                assert(account.tier === 'Standard', 'Should have been standard tier');
                assert(billing_promotions.length > 0, 'Should have had coupons')
                assert(billing_promotions[0].months === 12, 'should have been a 12 month coupon');
                assert(billing_promotions[0].consumed === false, 'should not have been used yet');
                //cancel our sub
                return adminAccountClient.users.cancelSubscription();
            }).then((account) => {
                assert(account.billing_subscription_status === 'CANCELED', 'Account still has subscription');
                assert(account.tier === 'Free', 'Should have been free tier');
                // now restart subscribe without a promo code (the only tier we currently have is Standard)
                return createTestStripePayment(stripeClient)
                    .then((paymentInfo) => {
                        return adminAccountClient.users.restartSubscription(paymentInfo.id);
                    });
            }).then((account) => {
                const {billing_promotions, billing_subscription_status} = account;
                assert(billing_subscription_status === 'ACTIVE', 'Account should have restarted subscription');
                assert(!_.isEmpty(billing_promotions), 'Restart should not have reset coupons');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });
    describe('#Check validity', () => {
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
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                adminAccountClient = client;
                return adminAccountClient.users.validatePromoCode(validPromoCode);
            }).then((result) => {
                assert(result.valid, 'Promo Code should have been valid');
                assert(result.months === 12, 'Code should be 12 months');
                assert(result.percent_off === 100.0, 'Should be a total discount');
                assert(result.code === validPromoCode, 'Should have been the passed in code')
                return adminAccountClient.users.validatePromoCode(invalidPromoCode);
            }).then((result) => {
                assert(!result.valid, 'Promo code should have been invalid');
                assert(result.code === invalidPromoCode, 'Should have been the passed in invalid code');
                return 'done';
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });
    describe('#Check adding coupons', () => {
        it('adds a coupon to an existing subscription', async () => {
            let adminAccountClient;
            const validPromoCode = 'Test12Month';
            const invalidPromoCode = 'TestInvalid';
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
                // make our client
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                adminAccountClient = client;
                return adminAccountClient.users.startSubscription('Standard');
            }).then((account) => {
                assert(account.billing_subscription_status === 'ACTIVE', 'Account did not subscribe');
                // first sleep to let the account promo reset work try an invalid code
                return adminAccountClient.users.addPromoToSubscription(invalidPromoCode)
                    .then(() => {
                        assert(false, 'Should have failed here')
                    }).catch(() => {
                        console.log('Yes, we got an expected error with an invalid code');
                        assert(true, 'Cool, subscription failed')
                        return account;
                    });
            }).then((account) => {
                console.log(account);
                assert(_.isEmpty(account.billing_promotions), 'Accounts shouldn\'t have promos');
                //now do a valid code
                return adminAccountClient.users.addPromoToSubscription(validPromoCode);
            }).then((account) => {
                const {billing_promotions, billing_subscription_status} = account;
                assert(billing_subscription_status === 'ACTIVE', 'Account did not subscribe');
                assert(billing_promotions.length > 0, 'Should have had coupons')
                assert(billing_promotions[0].months === 12, 'should have been a 12 month coupon');
                assert(billing_promotions[0].consumed === false, 'should not have been used yet');
                //now do it again, which should fail
                return adminAccountClient.users.addPromoToSubscription(validPromoCode)
                    .then(() => {
                        assert(false, 'Should have failed to add a duplicate');
                    }).catch(() => {
                        console.log('Excellent, adding duplicate code failed');
                        assert(true, 'No dupes for us')
                    });
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });
};
