/** Keep the displayed snapshot until its replacement has reached the renderer. */
export function createSnapshotHandoff(app) {
	const pending = new Map();
	let checkReady = null;

	function stopWaiting() {
		if (checkReady) app.off('postrender', checkReady);
		checkReady = null;
	}

	function retirePending() {
		for (const [entity, asset] of pending) {
			entity?.destroy();
			if (asset) {
				app.assets.remove(asset);
				asset.unload();
			}
		}
		pending.clear();
	}

	return {
		replace(next, previous, asset, empty = false) {
			stopWaiting();
			if (previous || asset) pending.set(previous, asset);
			if (!pending.size) return;
			checkReady = () => {
				// A sorter worker response alone is not enough: PlayCanvas must
				// upload the order and update the instance count before rendering.
				// Never expire the old snapshot on a timer or a fixed frame count.
				const count = next.gsplat?.instance?.meshInstance?.instancingCount ?? 0;
				if (!empty && count <= 0) return;
				stopWaiting();
				retirePending();
			};
			app.on('postrender', checkReady);
		},
		destroy() {
			stopWaiting();
			retirePending();
		},
	};
}
