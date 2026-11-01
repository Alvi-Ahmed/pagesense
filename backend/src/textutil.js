// Small text helpers shared by post generation and the catalog.
const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

export const toAscii = (t) => String(t ?? '').replace(/[০-৯]/g, (d) => BANGLA_DIGITS.indexOf(d));

// Every number written in a text, as plain ASCII digits without thousands commas: "১,২০০" -> "1200".
export const numbersIn = (text) => new Set(toAscii(text).replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) || []);
