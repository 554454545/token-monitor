'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const currencyApi = require('../../src/shared/currency');

test('widget cost labels include the selected currency without changing conversion', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const formatter = source.match(/function formatCost\(value\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(formatter);
  currencyApi.configureRates({ CNY: 7 });
  try {
    for (const code of currencyApi.CURRENCY_CODES) {
      for (const value of [0, 0.0001, 18.18]) {
        const result = vm.runInNewContext(`${formatter}\nformatCost(value)`, {
          currencyApi, currentCurrency: () => code, value
        });
        assert.equal(result, `${currencyApi.formatCurrencyFromUsd(value, code)} ${code}`);
      }
    }
  } finally {
    currencyApi.configureRates(null);
  }
});
