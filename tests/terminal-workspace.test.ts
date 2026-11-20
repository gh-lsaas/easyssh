import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneIds, removePane, replacePane, splitPane, reorderIds } from '../src/panes.ts';
import { exclusiveAction, clipboardShortcut } from '../src/clipboard.ts';
const pane = (session: string) => ({kind:'pane' as const,session});
test('split hidden tabs on either axis without duplicating sessions', () => {
  const tree = splitPane(pane('a'),'b','a','right');
  assert.deepEqual(paneIds(tree),['a','b']);
  assert.equal(tree?.kind === 'split' && tree.axis,'row');
  const nested = splitPane(tree,'c','b','top');
  assert.deepEqual(paneIds(nested),['a','c','b']);
  assert.equal(nested?.kind === 'split' && nested.second.kind === 'split' && nested.second.axis,'column');
});
test('moving a visible tab collapses its old split without duplicating it', () => {
  const tree = splitPane(splitPane(pane('a'),'b','a','right'),'c','b','bottom');
  assert.deepEqual(paneIds(splitPane(tree,'a','c','bottom')),['b','c','a']);
});
test('closing leaves collapses empty branches and the final pane', () => {
  const tree = splitPane(pane('a'),'b','a','left');
  assert.deepEqual(removePane(tree,'a'),pane('b'));
  assert.equal(removePane(removePane(tree,'a'),'b'),null);
});
test('activation replaces one pane and preserves the other visible panes', () => {
  const tree = splitPane(pane('a'),'b','a','right')!;
  assert.deepEqual(paneIds(replacePane(tree,'b','c')),['a','c']);
});
test('self-drops and missing targets do not damage layout', () => {
  const tree = pane('a');
  assert.equal(splitPane(tree,'a','a','left'),tree);
  assert.equal(splitPane(tree,'b','missing','left'),tree);
});
test('tab insertion accounts for moving from either side and appending', () => {
  assert.deepEqual(reorderIds(['a','b','c'],'a','b',true),['b','a','c']);
  assert.deepEqual(reorderIds(['a','b','c'],'c','a',false),['c','a','b']);
  assert.deepEqual(reorderIds(['a','b','c'],'a',null,true),['b','c','a']);
  assert.deepEqual(reorderIds(['a','b'],'a','a',true),['a','b']);
});
test('plain Ctrl+C stays an interrupt, clipboard shortcuts have one owner', () => {
  const event = {key:'c',ctrlKey:true,metaKey:false,shiftKey:false,altKey:false};
  assert.equal(clipboardShortcut(event),null);
  assert.equal(clipboardShortcut({...event,shiftKey:true}),'copy');
  assert.equal(clipboardShortcut({...event,key:'v'}),'paste');
  assert.equal(clipboardShortcut({...event,key:'V',shiftKey:true}),'paste');
  assert.equal(clipboardShortcut({...event,key:'Insert',ctrlKey:false,shiftKey:true}),'paste');
  assert.equal(clipboardShortcut({...event,key:'v',altKey:true}),null);
});
test('overlapping paste triggers cannot submit the clipboard twice', async () => {
  const run = exclusiveAction(); let pastes = 0;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = run(async () => { await waiting; pastes++; });
  await run(async () => { pastes++; });
  release(); await first;
  assert.equal(pastes,1);
  await run(async () => { pastes++; });
  assert.equal(pastes,2);
});
test('a failed clipboard read releases the paste lock', async () => {
  const run = exclusiveAction(); let retried = false;
  await assert.rejects(run(async () => { throw new Error('Clipboard unavailable'); }));
  await run(async () => { retried = true; }); assert.equal(retried,true);
});
