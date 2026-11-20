import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionSecret } from '../src/connection-auth.ts';

test('saved passwords connect without prompting or returning a credential to JS', async () => {
  const result = await resolveSessionSecret({auth:'password', forcePrompt:false,
    hasSavedSecret:async () => true, prompt:async () => { throw new Error('Unexpected prompt'); }});
  assert.equal(result, undefined);
});
test('a missing password prompts once and uses the answer', async () => {
  let prompts = 0;
  const result = await resolveSessionSecret({auth:'password', forcePrompt:false,
    hasSavedSecret:async () => false, prompt:async () => { prompts++; return 'session-only'; }});
  assert.equal(prompts, 1); assert.equal(result, 'session-only');
});
test('cancelled credentials do not start a connection', async () => {
  assert.equal(await resolveSessionSecret({auth:'password', forcePrompt:false,
    hasSavedSecret:async () => false, prompt:async () => null}), null);
});
test('private keys without saved passphrases can connect without a prompt', async () => {
  assert.equal(await resolveSessionSecret({auth:'key', forcePrompt:false,
    hasSavedSecret:async () => false, prompt:async () => { throw new Error('Unexpected prompt'); }}), undefined);
});
test('explicit credentials override both saved and temporary secrets', async () => {
  assert.equal(await resolveSessionSecret({auth:'password', forcePrompt:true, temporarySecret:'temporary',
    hasSavedSecret:async () => { throw new Error('Unexpected vault access'); }, prompt:async () => 'replacement'}), 'replacement');
});
test('temporary credentials do not access the vault or prompt', async () => {
  assert.equal(await resolveSessionSecret({auth:'password', forcePrompt:false, temporarySecret:'temporary',
    hasSavedSecret:async () => { throw new Error('Unexpected vault access'); }, prompt:async () => { throw new Error('Unexpected prompt'); }}), 'temporary');
});
test('credential store errors are reported instead of prompting to overwrite', async () => {
  await assert.rejects(resolveSessionSecret({auth:'password', forcePrompt:false,
    hasSavedSecret:async () => { throw new Error('Vault locked'); }, prompt:async () => { throw new Error('Unexpected prompt'); }}), /Vault locked/);
});
