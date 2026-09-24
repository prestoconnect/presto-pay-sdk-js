/**
 * The code lists, as frozen objects whose keys are the wire values verbatim — `Authorised`, not `AUTHORISED` —
 * so the gateway's vocabulary survives into the identifier for free. Every type is a union of the known values
 * widened with `string & {}`, so an unrecognized value the gateway sends still type-checks instead of being
 * rejected (the lists are open-ended).
 */

export const PaymentStatus = Object.freeze({
  PendingAuthorise: 'PendingAuthorise',
  Cancelled: 'Cancelled',
  Authorised: 'Authorised',
  Failed: 'Failed',
  PendingReverse: 'PendingReverse',
  Reversed: 'Reversed',
  PendingRefund: 'PendingRefund',
  PartialRefunded: 'PartialRefunded',
  Refunded: 'Refunded',
  Expired: 'Expired',
} as const);
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus] | (string & {});

export const ReversalStatus = Object.freeze({
  Reversing: 'Reversing',
  Failed: 'Failed',
  Success: 'Success',
} as const);
export type ReversalStatus = (typeof ReversalStatus)[keyof typeof ReversalStatus] | (string & {});

export const RefundStatus = Object.freeze({
  Refunding: 'Refunding',
  Failed: 'Failed',
  Success: 'Success',
} as const);
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus] | (string & {});

export const TxnType = Object.freeze({
  QrPay: 'QrPay',
  WebPay: 'WebPay',
  MiniAppPay: 'MiniAppPay',
} as const);
export type TxnType = (typeof TxnType)[keyof typeof TxnType] | (string & {});

export const PaymentMethod = Object.freeze({
  Wallet: 'Wallet',
  CashBack: 'CashBack',
  Card: 'Card',
  BigLife: 'BigLife',
  BonusLink: 'BonusLink',
  RISE: 'RISE',
  PlusMiles: 'PlusMiles',
  VSing: 'VSing',
  KLEAN: 'KLEAN',
  GOrewards: 'GOrewards',
  Subwallet_NearU: 'Subwallet_NearU',
  Subwallet_CARROTS: 'Subwallet_CARROTS',
  Subwallet_BUDDY: 'Subwallet_BUDDY',
  TuneTalk: 'TuneTalk',
  PmPgCard: 'PmPgCard',
  Maybank: 'Maybank',
  Ambank: 'Ambank',
  Rhb: 'Rhb',
  HongLeong: 'HongLeong',
  Cimb: 'Cimb',
  PublicBank: 'PublicBank',
  AffinBank: 'AffinBank',
  Bsn: 'Bsn',
  AllianceBank: 'AllianceBank',
  AgroBank: 'AgroBank',
  BankIslam: 'BankIslam',
  BankOfChina: 'BankOfChina',
  BankRakyat: 'BankRakyat',
  BankMuamalat: 'BankMuamalat',
  BoostBank: 'BoostBank',
  HsbcBank: 'HsbcBank',
  KuwaitFinanceHouse: 'KuwaitFinanceHouse',
  OcbcBank: 'OcbcBank',
  AlRajhiBank: 'AlRajhiBank',
  StandardChartered: 'StandardChartered',
  UobBank: 'UobBank',
  MbsbBank: 'MbsbBank',
  HongLeongPex: 'HongLeongPex',
  UnionPay: 'UnionPay',
  UnionPayQR: 'UnionPayQR',
  Boost: 'Boost',
  GrabPay: 'GrabPay',
  GrabPayLater: 'GrabPayLater',
  WeChatPayChina: 'WeChatPayChina',
  TouchNGo: 'TouchNGo',
  TouchNGoEWallet: 'TouchNGoEWallet',
  AliPayChina: 'AliPayChina',
  LatitudePay: 'LatitudePay',
  ApplePay: 'ApplePay',
  GooglePay: 'GooglePay',
  DuitNowQR: 'DuitNowQR',
} as const);
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod] | (string & {});

export const EventCode = Object.freeze({
  Authorised: 'Authorised',
  Cancelled: 'Cancelled',
  Reversed: 'Reversed',
  Refunded: 'Refunded',
  Expired: 'Expired',
} as const);
export type EventCode = (typeof EventCode)[keyof typeof EventCode] | (string & {});

/** Descriptive names mapped to the four-digit codes — `1203` is not a name. */
export const ErrorCode = Object.freeze({
  // Request and auth
  InvalidRequestPath: '1001',
  InvalidContentType: '1002',
  MissingMasterMerchantReference: '1003',
  InvalidTimestampFormat: '1004',
  ExceededValidityPeriod: '1005',
  InvalidSignature: '1006',
  SignatureVerificationFailed: '1007',
  MissingAuthorizationHeader: '1008',
  InvalidAuthorizationHeader: '1009',
  InvalidAccessToken: '1010',
  AccessTokenValidationError: '1011',
  InvalidAccessTokenOwnership: '1012',
  OAuthResourceConfigError: '1013',
  MissingOAuthScope: '1014',
  OAuthServiceUnavailable: '1015',
  // Merchant
  MerchantGeneralError: '1100',
  MerchantInvalidInput: '1101',
  InvalidMid: '1102',
  MasterMerchantInfoRetrievalFailed: '1103',
  MasterMerchantInfoServiceUnavailable: '1104',
  OnboardProcessingFailed: '1105',
  InvalidMerchantReference: '1106',
  DocumentUploadFailed: '1107',
  MissingDocument: '1108',
  RecordExists: '1109',
  ProfileNotFound: '1110',
  InvalidMerchantTxnType: '1111',
  FileRetryLimitExceeded: '1112',
  MerchantRejected: '1113',
  // Payment
  PaymentGeneralError: '1200',
  InvalidInput: '1201',
  InitFailed: '1202',
  DuplicateTxnRefNum: '1203',
  QrValueNotRecognised: '1204',
  QrValueNotBound: '1205',
  QrTotpExpired: '1206',
  QrValidationFailed: '1207',
  QrInvalidTotpSecret: '1208',
  QrInvalidTotp: '1209',
  QrInvalidPrefix: '1210',
  QrPaymentSuspended: '1211',
  PaymentNotFound: '1212',
  InvalidStatusForAuthorisation: '1213',
  AuthorisationGeneralError: '1214',
  QrValueAlreadyUsed: '1215',
  InvalidUser: '1216',
  QueryAccessDenied: '1217',
  QueryFailed: '1218',
  InvalidStatusForReversal: '1219',
  ReversalNotAllowedSettled: '1220',
  ReversalGracePeriodEnded: '1221',
  RefundToAccountFailed: '1222',
  ReversalFailed: '1223',
  ReversalAlreadyInProgress: '1224',
  InvalidPaymentMethod: '1225',
  RefundAlreadyInProgress: '1226',
  InvalidStatusForRefund: '1227',
  RefundGracePeriodEnded: '1228',
  InsufficientUnsettledAmount: '1229',
  RefundFailed: '1230',
  PaymentLimitExceeded: '1231',
  InvalidSessionValidityPeriod: '1232',
  InvalidSessionValidityFormat: '1233',
  PaymentMethodMismatch: '1234',
  RefundAmountExceedsTransaction: '1235',
  RefundableAmountExceeded: '1236',
  // User
  UserGeneralError: '1400',
  InvalidUserTokenFormat: '1401',
  UserTokenNotFound: '1402',
  UserReferenceRetrievalFailed: '1403',
  UserProfileRetrievalFailed: '1404',
  UserInfoRetrievalFailed: '1405',
} as const);
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode] | (string & {});
