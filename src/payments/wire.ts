/**
 * Validates a request and builds its wire body (js-plan.md §5 "Outgoing"). The result never includes `mid`,
 * `ts` or `signature` — those are added per attempt by the client, since `ts` must be fresh every time
 * (js-plan.md §3.9).
 */
import { formatGatewayTimestamp } from '../internal/timestamp.js';
import type { InitRequest, LineItem, QueryRequest, RefundRequest, ReverseRequest } from './types.js';
import {
  type FlatBody,
  optionalInteger,
  optionalString,
  put,
  requireAtLeastOneOf,
  requireAtMostOneOf,
  requireInteger,
  requireString,
  stringifyArray,
} from './validate.js';
import { PrestoPayConfigError } from '../errors.js';
import { TxnType } from './constants.js';

function buildLineItem(item: LineItem, index: number): Record<string, unknown> {
  const field = (name: string): string => `itemList[${index}].${name}`;
  const wire: Record<string, unknown> = {
    itemDesc: requireString(item.itemDesc, field('itemDesc'), 'init'),
    quantity: requireInteger(item.quantity, field('quantity'), 'init', { positive: true }),
    unitAmount: requireInteger(item.unitAmount, field('unitAmount'), 'init'),
    totalAmount: requireInteger(item.totalAmount, field('totalAmount'), 'init'),
  };
  put(wire, 'imageUrl', optionalString(item.imageUrl, field('imageUrl'), 'init'));
  put(wire, 'itemUrl', optionalString(item.itemUrl, field('itemUrl'), 'init'));
  put(wire, 'category', optionalString(item.category, field('category'), 'init'));
  put(wire, 'categoryDesc', optionalString(item.categoryDesc, field('categoryDesc'), 'init'));
  put(wire, 'supplier', optionalString(item.supplier, field('supplier'), 'init'));
  put(wire, 'supplierDesc', optionalString(item.supplierDesc, field('supplierDesc'), 'init'));
  put(wire, 'supplierUrl', optionalString(item.supplierUrl, field('supplierUrl'), 'init'));
  return wire;
}

function formatSessionValidity(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? formatGatewayTimestamp(value) : value;
}

export function buildInitBody(input: InitRequest, strict: boolean): FlatBody {
  const body: Record<string, unknown> = {
    prestoMrn: requireString(input.prestoMrn, 'prestoMrn', 'init'),
    txnType: requireString(input.txnType, 'txnType', 'init'),
    txnRefNum: requireString(input.txnRefNum, 'txnRefNum', 'init', 50, strict),
    displayDesc: requireString(input.displayDesc, 'displayDesc', 'init', 255, strict),
  };

  requireAtMostOneOf({ qrValue: input.qrValue, payerRefNum: input.payerRefNum }, 'init');
  if (input.amount !== undefined && input.currencyCode === undefined) {
    throw new PrestoPayConfigError('currencyCode: required when amount is set', {
      operation: 'init',
      field: 'currencyCode',
    });
  }
  if (input.txnType === TxnType.WebPay && input.redirectUrl === undefined) {
    throw new PrestoPayConfigError('redirectUrl: required when txnType is "WebPay"', {
      operation: 'init',
      field: 'redirectUrl',
    });
  }

  put(body, 'qrValue', optionalString(input.qrValue, 'qrValue', 'init'));
  put(body, 'payerRefNum', optionalString(input.payerRefNum, 'payerRefNum', 'init'));
  put(body, 'deviceRefNum', optionalString(input.deviceRefNum, 'deviceRefNum', 'init', 50, strict));
  put(body, 'deviceIp', optionalString(input.deviceIp, 'deviceIp', 'init', 50, strict));
  put(body, 'itemList', stringifyArray(input.itemList?.map(buildLineItem)));
  put(body, 'transactionalData', optionalString(input.transactionalData, 'transactionalData', 'init'));
  put(body, 'amount', optionalInteger(input.amount, 'amount', 'init', { positive: true }));
  put(body, 'currencyCode', optionalString(input.currencyCode, 'currencyCode', 'init'));
  put(body, 'notifyUrl', optionalString(input.notifyUrl, 'notifyUrl', 'init', 255, strict));
  put(body, 'redirectUrl', optionalString(input.redirectUrl, 'redirectUrl', 'init', 255, strict));
  put(body, 'sessionValidity', formatSessionValidity(input.sessionValidity));
  put(body, 'additionalData', optionalString(input.additionalData, 'additionalData', 'init', 255, strict));
  put(body, 'mode', optionalString(input.mode, 'mode', 'init', 50, strict));
  put(body, 'modeData', optionalString(input.modeData, 'modeData', 'init', 1000, strict));
  put(body, 'allowedPaymentMethods', stringifyArray(input.allowedPaymentMethods));
  put(body, 'bindData', optionalString(input.bindData, 'bindData', 'init'));
  put(body, 'themeRefNum', optionalString(input.themeRefNum, 'themeRefNum', 'init'));
  put(body, 'receiptEmail', optionalString(input.receiptEmail, 'receiptEmail', 'init', 320, strict));
  put(body, 'receiptName', optionalString(input.receiptName, 'receiptName', 'init', 200, strict));

  return body as FlatBody;
}

export function buildQueryBody(input: QueryRequest): FlatBody {
  requireAtLeastOneOf({ paymentRefNum: input.paymentRefNum, txnRefNum: input.txnRefNum }, 'query');
  const body: Record<string, unknown> = {
    prestoMrn: requireString(input.prestoMrn, 'prestoMrn', 'query'),
  };
  put(body, 'paymentRefNum', optionalString(input.paymentRefNum, 'paymentRefNum', 'query'));
  put(body, 'txnRefNum', optionalString(input.txnRefNum, 'txnRefNum', 'query'));
  return body as FlatBody;
}

export function buildReverseBody(input: ReverseRequest, strict: boolean): FlatBody {
  requireAtLeastOneOf({ paymentRefNum: input.paymentRefNum, txnRefNum: input.txnRefNum }, 'reverse');
  const body: Record<string, unknown> = {
    prestoMrn: requireString(input.prestoMrn, 'prestoMrn', 'reverse'),
    reversalRefNum: requireString(input.reversalRefNum, 'reversalRefNum', 'reverse', 50, strict),
  };
  put(body, 'paymentRefNum', optionalString(input.paymentRefNum, 'paymentRefNum', 'reverse'));
  put(body, 'txnRefNum', optionalString(input.txnRefNum, 'txnRefNum', 'reverse'));
  put(body, 'remark', optionalString(input.remark, 'remark', 'reverse', 200, strict));
  put(body, 'notifyUrl', optionalString(input.notifyUrl, 'notifyUrl', 'reverse', 255, strict));
  return body as FlatBody;
}

export function buildRefundBody(input: RefundRequest, strict: boolean): FlatBody {
  const body: Record<string, unknown> = {
    prestoMrn: requireString(input.prestoMrn, 'prestoMrn', 'refund'),
    paymentRefNum: requireString(input.paymentRefNum, 'paymentRefNum', 'refund'),
    refundRefNum: requireString(input.refundRefNum, 'refundRefNum', 'refund', 50, strict),
    remark: requireString(input.remark, 'remark', 'refund', 200, strict),
  };
  put(body, 'notifyUrl', optionalString(input.notifyUrl, 'notifyUrl', 'refund', 255, strict));
  put(body, 'amount', optionalInteger(input.amount, 'amount', 'refund', { positive: true }));
  return body as FlatBody;
}
