/**
 * Validates the single checkout form behind `POST /checkout`. Returns a field-name to message map (empty when
 * valid), mirroring the shape the page's own JavaScript expects back on a 400.
 */
export function validateCheckoutForm(body) {
  const errors = {};

  const displayDesc = typeof body.displayDesc === 'string' ? body.displayDesc.trim() : '';
  if (!displayDesc) errors.displayDesc = 'must not be blank';
  else if (displayDesc.length > 200) errors.displayDesc = 'size must be between 0 and 200';

  const amountInRinggit = typeof body.amountInRinggit === 'string' ? body.amountInRinggit.trim() : body.amountInRinggit;
  if (amountInRinggit === null || amountInRinggit === undefined || amountInRinggit === '') {
    errors.amountInRinggit = 'must not be null';
  } else if (!/^\d+(\.\d{1,2})?$/.test(String(amountInRinggit)) || Number(amountInRinggit) < 0.01) {
    errors.amountInRinggit = 'Amount must be at least 0.01';
  }

  const showPaymentMethods = Boolean(body.showPaymentMethods);
  const selectedPaymentMethod = typeof body.selectedPaymentMethod === 'string' ? body.selectedPaymentMethod.trim() : '';
  if (showPaymentMethods && !selectedPaymentMethod) {
    errors.selectedPaymentMethod = 'Select a payment method';
  }

  if (typeof body.pageTitle === 'string' && body.pageTitle.length > 80) {
    errors.pageTitle = 'size must be between 0 and 80';
  }
  if (typeof body.receiptName === 'string' && body.receiptName.length > 200) {
    errors.receiptName = 'size must be between 0 and 200';
  }
  if (typeof body.receiptEmail === 'string' && body.receiptEmail.length > 320) {
    errors.receiptEmail = 'size must be between 0 and 320';
  }

  return errors;
}

export function toMinorUnits(amountInRinggit) {
  const [whole, fraction = ''] = String(amountInRinggit).split('.');
  return Number(`${whole}${fraction.padEnd(2, '0')}`);
}
