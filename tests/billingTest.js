import assert from 'assert';
import _ from 'lodash';
import uclusion from 'uclusion_sdk';
import TestTokenManager, {TOKEN_TYPE_ACCOUNT} from '../src/TestTokenManager';
import {getMessages, getSSOInfo} from '../src/utils';
import Stripe from 'stripe';

/*
Admin Configuration and User Configuration are used as in/out params here,
so that we don't have to keep making accounts for every separate test
 */
module.exports = function (adminConfiguration, userConfiguration, stripeConfiguration) {

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

    function isSubscribed(account) {
        return ['ACTIVE', 'FREE'].includes(account.billing_subscription_status);
    }

    describe('#Test without coupons', () => {
        it('create a subscription without coupons', async () => {
            let adminAccountClient;
            //first load stripe
            const stripeClient = new Stripe(stripeConfiguration.public_api_key, {apiVersion: '2020-08-27'});
            await getSSOInfo(adminConfiguration).then((info) => {
                const { ssoClient, idToken } = info;
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient,
                    idToken);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                // make our client
                adminAccountClient = client;
                //cancel our sub
                return adminAccountClient.users.cancelSubscription();
            }).then((account) => {
                assert(account.billing_subscription_status === 'CANCELED', 'Account still has subscription');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const upgradeReminder = messages.find(obj => {
                    return obj.market_id_user_id.startsWith('upgrade_reminder');
                });
                assert(upgradeReminder, 'Upgrade reminder not received');
                // now restart subscribe without a promo code
                return createTestStripePayment(stripeClient)
                    .then((paymentInfo) => {
                        return adminAccountClient.users.restartSubscription(paymentInfo.id);
                    });
            }).then((account) => {
                assert(account.billing_subscription_status === 'ACTIVE', 'Account should have restarted subscription');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const upgradeReminder = messages.find(obj => {
                    return obj.market_id_user_id.startsWith('upgrade_reminder');
                });
                assert(!upgradeReminder, 'Upgrade reminder should have been cleared');
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
            let adminIdToken;
            //first load stripe
            const stripeClient = new Stripe(stripeConfiguration.public_api_key, {apiVersion: '2020-08-27'});
            await getSSOInfo(adminConfiguration).then((info) => {
                const { ssoClient, idToken } = info;
                adminIdToken = idToken;
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient,
                    idToken);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                //make our client
                adminAccountClient = client;
                return adminAccountClient.users.restartSubscription( undefined, promoCode);
            }).then((account) => {
                //console.log(account)
                const {billing_promotions} = account;
                console.dir(account);
                assert(isSubscribed(account), 'Account did not subscribe');
                assert(billing_promotions.length > 0, 'Should have had coupons')
                assert(billing_promotions[0].months === 12, 'should have been a 12 month coupon');
                assert(billing_promotions[0].consumed === false, 'should not have been used yet');
                //cancel our sub
                return adminAccountClient.users.cancelSubscription();
            }).then((account) => {
                assert(account.billing_subscription_status === 'CANCELED', 'Account still has subscription');
                // now restart subscribe without a promo code
                return createTestStripePayment(stripeClient)
                    .then((paymentInfo) => {
                        return adminAccountClient.users.restartSubscription(paymentInfo.id, promoCode);
                    });
            }).then((account) => {
                const {billing_promotions} = account;
                assert(isSubscribed(account), 'Account should have restarted subscription');
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
            //first load stripe
            const stripeClient = new Stripe(stripeConfiguration.public_api_key, {apiVersion: '2020-08-27'});
            await getSSOInfo(adminConfiguration).then((info) => {
                const { ssoClient, idToken } = info;
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient,
                    idToken);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                //make our client
                adminAccountClient = client;
                return adminAccountClient.users.restartSubscription( undefined, promoCode);
            }).then((account) => {
                //console.log(account)
                const {billing_promotions} = account;
                assert(isSubscribed(account), 'Account did not subscribe');
                assert(billing_promotions.length > 0, 'Should have had coupons')
                assert(billing_promotions[0].months === 12, 'should have been a 12 month coupon');
                assert(billing_promotions[0].consumed === false, 'should not have been used yet');
                //cancel our sub
                return adminAccountClient.users.cancelSubscription();
            }).then((account) => {
                assert(account.billing_subscription_status === 'CANCELED', 'Account still has subscription');
                // now restart subscribe without a promo code
                return createTestStripePayment(stripeClient)
                    .then((paymentInfo) => {
                        return adminAccountClient.users.restartSubscription(paymentInfo.id);
                    });
            }).then((account) => {
                const {billing_promotions} = account;
                assert(isSubscribed(account), 'Account should have restarted subscription');
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
            await getSSOInfo(adminConfiguration).then((info) => {
                const { ssoClient, idToken } = info;
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient,
                    idToken);
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
            await getSSOInfo(adminConfiguration).then((info) => {
                const { ssoClient, idToken } = info;
                const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient,
                    idToken);
                const config = {...adminConfiguration, tokenManager};
                return uclusion.constructClient(config);
            }).then((client) => {
                adminAccountClient = client;
                // first sleep to let the account promo reset work try an invalid code
                return adminAccountClient.users.addPromoToSubscription(invalidPromoCode)
                    .then(() => {
                        assert(false, 'Should have failed here')
                    }).catch(() => {
                        console.log('Yes, we got an expected error with an invalid code');
                        assert(true, 'Cool, subscription failed')
                    });
            }).then(() => {
                //now do a valid code
                return adminAccountClient.users.addPromoToSubscription(validPromoCode);
            }).then((account) => {
                const {billing_promotions} = account;
                assert(isSubscribed(account), 'Account did not subscribe');
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
