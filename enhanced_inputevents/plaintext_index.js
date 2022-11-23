import { MutationDiff } from "./mutation_diff";

export class PlaintextIndex{
	MEMORY_LIMIT = ;
	constructor(root){
		this.root = root;
		this.diff = new MutationDiff();
		this.walker = document.createTreeWalker(root, NodeFilter.TEXT_NODE);
		this.anchor = null;
		this.edits = [];
	}
	/** Update the plaintext index given some DOM changes to `root`
	 * @param {MutationRecord} record
	 * @param {Boolean} synchronize whether the DOM 
	 */
	mutation(r, synchronize){
		if (!this.anchor)
			return;
		const t = r.target;
		switch (r.type){
			case "characterData": 
				const c = CumSumCache.get(t);
				if (c && c.length != t.length)
					this.diff.custom(t, "length", t.length, c.length);
				break;
			case "childList":
				this.diff.children(t, r.removedNodes, r.addedNodes, r.previousSibling, r.nextSibling);
				break;
		}
		if (this.diff.storage_size > this.MEMORY_LIMIT)
			this.#update_anchor();
	}
	/** For a given anchor, return the absolute plaintext offset in root. This uses a caching
	 * 	mechanism to be O(1) on average.
	 * @param node anchor node; must be inside root
	 * @param {Number} offset anchor offset inside node, in the manner of Range.start/endOffset
	 * @returns {Number} absolute offset
	 */
	absolute_offset(node, offset){
		if (this.anchor)
			this.#update_anchor();
		// convert to a textnode lookup
		if (node.nodeType != Node.TEXT_NODE){
			this.text_walker.currentNode = node;
			// we cache from start, so better to get previous
			node = this.text_walker.previousNode();
			if (!node)
				return 0;
			offset = node.length;
		}
		this.#update(
			(anchor, cache) => anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
			(anchor, cache) => anchor === node
		);
		return CumSumCache.get(node).absolute_offset(offset);
	}
	/** Given absolute offsets, calculate their corresponding anchor positions. This is an O(N)
	 * 	lookup in the number of text nodes, unlike absolute_offset which is O(1). You can batch
	 * 	many offset lookups together for little additional cost.
	 * @param {[Number]} offsets absolute plaintext offsets, such as one returned from `absolute_offset`;
	 * 	must be sorted in ascending order; each offset must be between [0, root.textContent.length]
	 * @returns Ordered list of {node, offset} anchors, each corresponding to an offset in
	 * 	the input list; node/offset suitable for use in Range. Where a plaintext offset is on
	 * 	the border of two text nodes, the following one in DOM tree order is returned.
	 */
	relative_offsets(offsets){
		if (this.anchor)
			this.#update_anchor();
		// cache up to the last offset
		const last = offsets[offsets.length-1];
		const fulfills_request = (anchor, cache) => {
			return cache.sum + cache.length >= last;
		};
		this.#update(fulfills_request, fulfills_request);
		// while we can halve the search by starting search with anchor vs root, for batched offset
		// lookups, on average it's not going to matter; we'll start from anchor since text edits
		// are usually at the end
		const anchors = [];
		let node = this.anchor;
		this.text_walker.currentNode = node;
		for (let i=offsets.length-1; i>=0; i--){
			const aoffset = offsets[i];
			let offset;
			while (true){
				offset = CumSumCache.get(node).relative_offset(aoffset);
				if (offset < 0)
					node = this.text_walker.previousNode();
				else break;
			}
			anchors.unshift({node, offset});
		}
		return anchors;
	}

	#update_anchor(){
		const range = this.diff.range(this.root);
		if (range === null)
			return;
		// if anchor is before mutated range, then we're safe
		const p = range.after.compareDocumentPosition(this.anchor);
		if (p & (Node.DOCUMENT_POSITION_DISCONNECTED | Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC))
			throw Error("mutations were disconnected from root");
		if (p & Node.DOCUMENT_POSITION_PRECEDING || (!p || p & Node.DOCUMENT_POSITION_CONTAINED_BY) && range.after_close)
			return;
		

	}
	/** Update plaintext lookup cache:
	 *	To find the absolute offset, you need to sum all Text.length up to a node.
	 *	You can use a data structure like a binary indexed tree to make this a log(n)
	 *	lookup. However, we'll instead just cache the cumulative sum with an anchor
	 *	node indicating to what point the sum has been computed. The mutation observer
	 *	can check if nodes were modified, and move the anchor below them so that their
	 *	summation is recalculated. While I haven't tested, I believe this will be faster
	 *	than a dedicated data structure in 99% of cases. The predominant use case is when
	 *	users are typing text in a single text node, and so this will be O(1).
	 *
	 *	Note: could also consider building cache backwards from end instead of start;
	 *		though I think on average it doesn't make a difference
	 *
	 * @param start_condition `fn(anchor, anchor._revertdom_plaintext_cache) -> bool;
	 * 	return true if having summations cached up to this anchor is sufficient (no cache updates will be made)
	 * @param stop_condition callback(anchor, anchor._revertdom_plaintext_cache) -> bool;
	 * 	return true if we should stop calculating the summation; note an error will be thrown
	 * 	if you don't stop the summation before the end of root
	 */
	#update(start_condition, stop_condition){
		if (this.anchor && !start_condition(this.anchor, CumSumCache.get(this.anchor)))
			return;
		let sum, nxt;
		// recompute completely
		if (!this.anchor){
			sum = 0;
			this.walker.currentNode = this.root;
			nxt = this.walker.nextNode();
		}
		// extend summation
		else{
			const c = CumSumCache.get(this.anchor);
			sum = c.sum + c.length;
			this.walker.currentNode = this.anchor;
			nxt = this.walker.nextNode();
		}
		while (true){
			if (!nxt)
				throw Error("assertion error: plaintext cache reached the end of root");
			const length = nxt.length;
			const c = new CumSumCache(nxt, sum, length);
			if (stop_condition(nxt, c))
				break;
			sum += length;
			nxt = this.walker.nextNode();
		}
		this.anchor = nxt;
	}
}

class CumSumCache{
	KEY = "_plaintextindex_cumsum"
	constructor(node, sum, length){
		/** @member {number} sum total of all node data lengths preceding this node */
		this.sum = sum;
		/** @member {number} length node's data length */
		this.length = length;
		// save directly on node
		node[CumSumCache.KEY] = this;
	}
	/** Get an absolute offset, given a relative one inside this node */
	absolute_offset(offset){ return this.sum + offset; }
	/** Get a relative offset inside this node, given an absolute one */
	relative_offset(offset){ return offset - this.sum; }
	/** Fetch the cache for a node, if one exists
	 * @param {Node} node to get cache for
	 * @returns {CumSumCache | undefined}
	 */
	static get(node){ return node[CumSumCache.KEY]; }
}