/** Wire field names on the way in and on the way out — no separate DTO naming to memorize. */
import type { PaymentMethod, PaymentStatus, RefundStatus, ReversalStatus, TxnType } from './constants.js';

export interface LineItem {
  readonly itemDesc: string;
  readonly quantity: number;
  readonly unitAmount: number;
  readonly totalAmount: number;
  readonly imageUrl?: string;
  readonly itemUrl?: string;
  readonly category?: string;
  readonly categoryDesc?: string;
  readonly supplier?: string;
  readonly supplierDesc?: string;
  readonly supplierUrl?: string;
}

export interface InitRequest {
  readonly prestoMrn: string;
  readonly txnType: TxnType;
  readonly txnRefNum: string;
  readonly displayDesc: string;
  readonly qrValue?: string;
  readonly payerRefNum?: string;
  readonly deviceRefNum?: string;
  readonly deviceIp?: string;
  readonly itemList?: readonly LineItem[];
  readonly transactionalData?: string;
  readonly amount?: number;
  readonly currencyCode?: string;
  readonly notifyUrl?: string;
  readonly redirectUrl?: string;
  readonly sessionValidity?: Date | string;
  readonly additionalData?: string;
  readonly mode?: string;
  readonly modeData?: string;
  readonly allowedPaymentMethods?: readonly PaymentMethod[];
  readonly bindData?: string;
  readonly themeRefNum?: string;
  readonly receiptEmail?: string;
  readonly receiptName?: string;
}

export interface InitResponse {
  readonly prestoMrn: string;
  readonly paymentRefNum: string;
  readonly paymentStatus: PaymentStatus;
  readonly txnRefNum?: string;
  readonly paymentUrl?: string;
  readonly userRefNum?: string;
  readonly amount?: number;
  readonly currencyCode?: string;
  readonly paymentRequestDate?: string;
  readonly paymentFinalisedDate?: string;
  readonly additionalData?: string;
}

export interface QueryRequest {
  readonly prestoMrn: string;
  readonly paymentRefNum?: string;
  readonly txnRefNum?: string;
}

export interface RefundDetail {
  readonly refundRefNum: string;
  readonly prestoRefundRefNum: string;
  readonly refundStatus: RefundStatus;
  readonly refundRequestDate: string;
  readonly refundFinalisedDate?: string;
}

export interface PaymentDetail {
  readonly amount: number;
  readonly method?: string;
  readonly cardBin?: string;
  readonly cardSummary?: string;
  readonly cardType?: string;
  readonly refNum?: string;
}

export interface QueryResponse {
  readonly prestoMrn: string;
  readonly paymentRefNum: string;
  readonly txnRefNum?: string;
  readonly userRefNum?: string;
  readonly paymentStatus?: PaymentStatus;
  readonly amount?: number;
  readonly currencyCode?: string;
  readonly paymentRequestDate?: string;
  readonly paymentFinalisedDate?: string;
  readonly reversalRefNum?: string;
  readonly prestoReversalRefNum?: string;
  readonly reversalStatus?: ReversalStatus;
  readonly reversalDate?: string;
  readonly refundRefNum?: string;
  readonly prestoRefundRefNum?: string;
  readonly refundStatus?: RefundStatus;
  readonly refundRequestDate?: string;
  readonly refundFinalisedDate?: string;
  readonly additionalData?: string;
  readonly refundDetails: readonly RefundDetail[];
  readonly paymentDetails: readonly PaymentDetail[];
}

export interface ReverseRequest {
  readonly prestoMrn: string;
  readonly reversalRefNum: string;
  readonly paymentRefNum?: string;
  readonly txnRefNum?: string;
  readonly remark?: string;
  readonly notifyUrl?: string;
}

export interface ReverseResponse {
  readonly prestoMrn: string;
  readonly paymentRefNum: string;
  readonly prestoReversalRefNum?: string;
  readonly amount?: number;
  readonly currencyCode?: string;
  readonly paymentStatus?: PaymentStatus;
}

export interface RefundRequest {
  readonly prestoMrn: string;
  readonly paymentRefNum: string;
  readonly refundRefNum: string;
  readonly remark: string;
  readonly notifyUrl?: string;
  readonly amount?: number;
}

export interface RefundResponse {
  readonly prestoMrn: string;
  readonly paymentRefNum: string;
  readonly prestoRefundRefNum?: string;
  readonly amount?: number;
  readonly refundAmount?: number;
  readonly currencyCode?: string;
  readonly paymentStatus?: PaymentStatus;
  readonly refundedDate?: string;
}
