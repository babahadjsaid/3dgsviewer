import assert from 'node:assert/strict';
import { EventHandler } from 'playcanvas/build/playcanvas.mjs';
import { createSnapshotHandoff } from '../dist/snapshot-handoff.js';
const app = new EventHandler();
app.assets = { remove(asset) { asset.removed = true; } };
const handoff = createSnapshotHandoff(app);
const model = () => ({
 entity: { gsplat: { instance: { meshInstance: { instancingCount: 0 } } }, destroy() { this.destroyed = true; } },
 asset: { unload() { this.unloaded = true; } },
});
const a=model(), b=model(), c=model();
const replace=(next, previous)=>handoff.replace(next.entity, previous.entity, previous.asset);
replace(b,a);
for(let i=0;i<300;i++) app.fire('postrender');
assert.ok(!a.entity.destroyed, 'slow sorting must never retire the displayed model on a timer');
replace(c,b);
b.entity.gsplat.instance.meshInstance.instancingCount=1;
app.fire('postrender');
assert.ok(!a.entity.destroyed, 'superseded snapshot cannot retire the visible model');
c.entity.gsplat.instance.meshInstance.instancingCount=1;
app.fire('postrender');
for(const old of [a,b]) {
 assert.equal(old.entity.destroyed,true);
 assert.equal(old.asset.removed,true);
 assert.equal(old.asset.unloaded,true);
}
assert.ok(!c.entity.destroyed);
assert.equal(app.hasEvent('postrender'),false);
const d=model(); replace(d,c);
handoff.destroy();
assert.equal(c.entity.destroyed,true);
assert.equal(app.hasEvent('postrender'),false);
assert.doesNotThrow(()=>app.fire('postrender'));
assert.doesNotThrow(()=>handoff.destroy());
const emptyHandoff = createSnapshotHandoff(app);
const old = model(), empty = model();
emptyHandoff.replace(empty.entity, old.entity, old.asset, true);
app.fire('postrender');
assert.equal(old.entity.destroyed, true, 'an explicitly empty snapshot clears the previous model');
emptyHandoff.destroy();
console.log('snapshot-handoff-check: ok');
