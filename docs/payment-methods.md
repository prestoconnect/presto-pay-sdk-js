# Payment methods

This page lists the payment method codes the SDK knows. It assumes you've set up a client as in the
[quick start](../README.md#quick-start).

Payment method codes appear in two places: in `allowedPaymentMethods`, which you can pass to `init`, and in
`method` on each entry that a `query` result or a webhook event returns in `paymentDetails`. You only need
`allowedPaymentMethods` if you build your own payment selection page; otherwise the shopper chooses on
Presto's page.

**Which methods you can use depends on your account.** Presto enables payment methods for each merchant during
onboarding. A code being listed here doesn't make it available to you; ask Presto which methods are enabled
for your account, or to enable more.

- [Codes are plain strings](#codes-are-plain-strings)
- [Methods that need a Presto account](#methods-that-need-a-presto-account)
- [Legacy methods](#legacy-methods)
- [All payment methods](#all-payment-methods)

## Codes are plain strings

The constants are a convenience: each one's value is exactly the code Presto sends and receives, and every
field that holds a payment method is a plain string. So when Presto adds a payment method, you don't need a
new SDK release to use it. Pass its code as a string:

```ts
const payment = await presto.payments.init({
  // ...
  allowedPaymentMethods: [PaymentMethod.TouchNGoEWallet, 'NewMethodCode'],
});
```

The `PaymentMethod` type accepts any string, so this compiles without a cast.

Like any other code, it works only once Presto has enabled it for your account.

The same applies to what you read back. `method` is a `string`. Compare it with the constants, and give any
`switch` on it a `default` case that handles a code you don't recognise without failing: store and show it as
it is.

## Methods that need a Presto account

To pay with one of these, the shopper logs in to their Presto account on Presto's payment page. If you limit
`allowedPaymentMethods` to these methods only, shoppers without a Presto account can't pay.

| Code | Constant | What it is |
|------|----------|------------|
| `Wallet` | `PaymentMethod.Wallet` | PrestoPay eWallet |
| `CashBack` | `PaymentMethod.CashBack` | PrestoPay Credits |
| `Card` | `PaymentMethod.Card` | Tokenised card saved to the shopper's Presto account |

Loyalty programmes, where the shopper pays with points:

| Code | Constant | Programme |
|------|----------|-----------|
| `Subwallet_NearU` | `PaymentMethod.Subwallet_NearU` | NearU Points |
| `Subwallet_CARROTS` | `PaymentMethod.Subwallet_CARROTS` | Carrots |
| `Subwallet_BUDDY` | `PaymentMethod.Subwallet_BUDDY` | Buddy+ |
| `BigLife` | `PaymentMethod.BigLife` | AirAsia rewards (legacy) |
| `BonusLink` | `PaymentMethod.BonusLink` | BonusLink |
| `GOrewards` | `PaymentMethod.GOrewards` | GOrewards |
| `RISE` | `PaymentMethod.RISE` | RISE |
| `PlusMiles` | `PaymentMethod.PlusMiles` | PlusMiles |
| `VSing` | `PaymentMethod.VSing` | VSing |
| `KLEAN` | `PaymentMethod.KLEAN` | KLEAN |

`Card` and `PmPgCard` are both card payments. `Card` uses a card the shopper saved to their Presto account;
with `PmPgCard`, the shopper enters card details on Presto's payment page and doesn't need to log in.

## Legacy methods

Don't use these in new integrations:

- `TouchNGo`: use `TouchNGoEWallet` instead.
- `BigLife` (AirAsia rewards).

## All payment methods

Which of these you can use depends on what Presto enabled for your account during onboarding.

| Code | Constant | Notes |
|------|----------|-------|
| `Wallet` | `PaymentMethod.Wallet` | PrestoPay eWallet. Needs a Presto account |
| `CashBack` | `PaymentMethod.CashBack` | PrestoPay Credits. Needs a Presto account |
| `Card` | `PaymentMethod.Card` | Tokenised card. Needs a Presto account |
| `BigLife` | `PaymentMethod.BigLife` | Loyalty: AirAsia rewards (legacy). Needs a Presto account |
| `BonusLink` | `PaymentMethod.BonusLink` | Loyalty points. Needs a Presto account |
| `RISE` | `PaymentMethod.RISE` | Loyalty points. Needs a Presto account |
| `PlusMiles` | `PaymentMethod.PlusMiles` | Loyalty points. Needs a Presto account |
| `VSing` | `PaymentMethod.VSing` | Loyalty points. Needs a Presto account |
| `KLEAN` | `PaymentMethod.KLEAN` | Loyalty points. Needs a Presto account |
| `GOrewards` | `PaymentMethod.GOrewards` | Loyalty points. Needs a Presto account |
| `Subwallet_NearU` | `PaymentMethod.Subwallet_NearU` | Loyalty: NearU Points. Needs a Presto account |
| `Subwallet_CARROTS` | `PaymentMethod.Subwallet_CARROTS` | Loyalty: Carrots. Needs a Presto account |
| `Subwallet_BUDDY` | `PaymentMethod.Subwallet_BUDDY` | Loyalty: Buddy+. Needs a Presto account |
| `TuneTalk` | `PaymentMethod.TuneTalk` | |
| `PmPgCard` | `PaymentMethod.PmPgCard` | Card entered on Presto's payment page |
| `Maybank` | `PaymentMethod.Maybank` | |
| `Ambank` | `PaymentMethod.Ambank` | |
| `Rhb` | `PaymentMethod.Rhb` | |
| `HongLeong` | `PaymentMethod.HongLeong` | |
| `Cimb` | `PaymentMethod.Cimb` | |
| `PublicBank` | `PaymentMethod.PublicBank` | |
| `AffinBank` | `PaymentMethod.AffinBank` | |
| `Bsn` | `PaymentMethod.Bsn` | |
| `AllianceBank` | `PaymentMethod.AllianceBank` | |
| `AgroBank` | `PaymentMethod.AgroBank` | |
| `BankIslam` | `PaymentMethod.BankIslam` | |
| `BankOfChina` | `PaymentMethod.BankOfChina` | |
| `BankRakyat` | `PaymentMethod.BankRakyat` | |
| `BankMuamalat` | `PaymentMethod.BankMuamalat` | |
| `BoostBank` | `PaymentMethod.BoostBank` | |
| `HsbcBank` | `PaymentMethod.HsbcBank` | |
| `KuwaitFinanceHouse` | `PaymentMethod.KuwaitFinanceHouse` | |
| `OcbcBank` | `PaymentMethod.OcbcBank` | |
| `AlRajhiBank` | `PaymentMethod.AlRajhiBank` | |
| `StandardChartered` | `PaymentMethod.StandardChartered` | |
| `UobBank` | `PaymentMethod.UobBank` | |
| `MbsbBank` | `PaymentMethod.MbsbBank` | |
| `HongLeongPex` | `PaymentMethod.HongLeongPex` | |
| `UnionPay` | `PaymentMethod.UnionPay` | |
| `UnionPayQR` | `PaymentMethod.UnionPayQR` | |
| `Boost` | `PaymentMethod.Boost` | |
| `GrabPay` | `PaymentMethod.GrabPay` | |
| `GrabPayLater` | `PaymentMethod.GrabPayLater` | |
| `WeChatPayChina` | `PaymentMethod.WeChatPayChina` | |
| `TouchNGo` | `PaymentMethod.TouchNGo` | Legacy; use `TouchNGoEWallet` |
| `TouchNGoEWallet` | `PaymentMethod.TouchNGoEWallet` | Touch 'n Go eWallet |
| `AliPayChina` | `PaymentMethod.AliPayChina` | |
| `LatitudePay` | `PaymentMethod.LatitudePay` | |
| `ApplePay` | `PaymentMethod.ApplePay` | |
| `GooglePay` | `PaymentMethod.GooglePay` | |
| `DuitNowQR` | `PaymentMethod.DuitNowQR` | |
