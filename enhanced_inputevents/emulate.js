/* To emulate `compositionborder`, we'll prepend a zero-width space \u200B. For this demo, we'll
	assume every element has `compositionborder=true` set, so don't need to append the space as well.
	Some quirks with this method:
	- Only works with single word compositions
	- User can make a selection of seemingly nothing, which I don't think can be fixed
	- In all browsers I've tested, deleting the zero-width space will end composition and emit a cancelable delete
		content beforeinput; so we can redirect the deletion to the appropriate textnode to delete an adjacent
		character instead
	- The cursor can be moved across the zero-width space; only noticeable when using arrow keys to navigate; we can
		fix this by moving the selection to the adjacent character, either forward or backward depending on what the
		previous cursor position was

	Except for Chrome, it seems there is just a single target range of composition, so the emulated compositionborder can
	ensure composition is restricted to that element. For Chrome, changing selection will not emit compositionend, so
	the additional range may be outside the compositionborder element. To handle that, we can check the window selection
	in compositionupdate, and if it is outside initial composition boundary, force the composition to be canceled.

	We can use the traditional hack for emulating requestCompositionEnd.

	For this demo, we assume very element has `compositionborder=true`, meaning composition only affects text nodes.
	To emulate reverting the DOM, we'll just restore the original textContent. We'll track the edited ranges using
	the algorithm I described in the proposal.
*/

// the zero-width space hack
export function setTextContent(el, txt){
	el.textContent = `\u200B${txt}`;
}
export function getTextContent(el){
	return el.textContent.substring(1);
}

/** Length of CharacterData, ignoring starting/trailing zero width space */
function zerowidthspace_length(data){
	const l = data.length;
	return l - (data[0] === '\u200B') - (l > 1 && data.at(-1) === '\u200B');
}

/** Convert Selection to [Range] */
function selection2ranges(sel){
	let ranges = [];
	for (let ri=0; ri<sel.rangeCount; ri++)
		ranges.push(sel.getRangeAt(ri))
	return ranges;
}
/** Convert StaticRange to Range */
function staticrange2range(range){
	const r = new Range();
	r.setStart(range.startContainer, range.startOffset);
	r.setEnd(range.endContainer, range.endOffset);
}

/** Return true if the element has compositionborder set to true */
function is_compositionborder(el){
	return el.compositionBorder === "true" || // JS
		el.getAttribute("compositionborder") === "true"; // HTML
}

/** Get the range for composition given an anchor point. Boundaries are indicated
 * 	by both compositionBorder=true and a change in isContentEditable (if we assume anchor
 * 	cannot be inside a non-editable element, than it is simply isContentEditable=false)
 * @param node anchor node
 * @param offset anchor offset inside node, in the manner of Range.start/endOffset
 * @param root container to bound the search; could be a top-level contenteditable container, if known
 * @returns {Range} a range giving the composition boundary start/end; can be collapsed, in which
 * 	case composition would insert a new Text node at that point
 */
function composition_boundary(node, offset, root=document.body){
	// can't use TreeWalker unfortunately, since we need both pre and post-traversal
	// of nodes, for both left and right sides of the range
	const t = node.nodeType;
	const istext = t == Node.TEXT_NODE || t == Node.CDATA_SECTION_NODE || t == Node.COMMENT_NODE;
	// to detect whether isContentEditable changes, we need the initial state at this anchor
	let anchor_editable;
	const fltr = n => {
		// boundary condition
		return (n.nodeType == Node.ELEMENT_NODE && (
			is_compositionborder(n) ||
			n.isContentEditable !== anchor_editable));
	};
	// where to start searching
	let lstart, rstart;
	if (istext){
		anchor_editable = node.parentNode.isContentEditable;
		lstart = {node, open:true, inclusive:false};
		rstart = {node, open:false, inclusive:false};
	}
	else{
		anchor_editable = node.isContentEditable;
		if (!offset){
			lstart = {node, open:true, inclusive:true};
			rstart = {node, open:true, inclusive:false};
		}
		else if (offset == node.childNodes.length){
			lstart = {node, open:false, inclusive:false};
			rstart = {node, open:false, inclusive:true};
		}
		else{
			let child = node.childNodes[offset-1];
			lstart = {node:child, open:false, inclusive:true};
			rstart = {node:child, oepn:false, inclusive:false};
		}
	}
	// find boundary
	function find_bound(){	
		for (const b of boundary_traversal.apply(null, arguments))
			return b;
	}
	const lbound = find_bound(root, lstart, false, fltr) || {node:root, open:true};
	const rbound = find_bound(root, rstart, true, fltr) || {node:root, open:false};
	// convert to Range
	const r = new Range();
	if (lbound.open)
		r.setStart(lbound.node, 0)
	else r.setStartAfter(lbound.node);
	if (!rbound.open)
		r.setEnd(rbound.node, rbound.node.childNodes.length);
	else r.setEndBefore(rbound.node);
	return r;
}

/** Traverse node boundaries of a static DOM. This will use pre-order traversal when
 * 	iterating child nodes and post-order for iterating parent nodes, regardless of direction.
 * 	This is in contrast to TreeWalker, which uses pre-order for next nodes, and post-order for
 * 	previous nodes. The purpose of this ordering is to always traverse a node boundary before any
 * 	children enclosed in that node.
 * @param root root of the traversal
 * @param {node, open, inclusive} start where to start the traversal:
 * 	- node: node to start with
 * 	- open: whether to start with the open or closing boundary of this node
 * 	- inclusive: whether the opening/closing boundary should be included
 * E.g. using {open:false, inclusive:false} and next=true will skip past the starting node
 * @param {bool} next direction to traverse, false = previous
 * @param {fltr} fltr filter for yielding a node
 * @yields an object {node, open}, where open indicates whether we are yielding at the opening
 * 	vs closing boundary of a node (e.g. for an HTMLElement, this corresponds to the open/close tags)
 */
function* boundary_traversal(root, start, next, fltr){
	let {node, open, inclusive} = start;
	function* traverse_children(node){
		if (fltr && !fltr(node))
			return;
		// to handle starting conditions
		const children = open == next;
		const preorder = children && inclusive;
		const postorder = children != inclusive;
		open = next;
		inclusive = true;
		// traverse
		if (preorder)
			yield {node, open:next};
		if (children){
			const l = node.childNodes.length;
			for (let i=(next ? 0 : l-1); i != (next ? l : -1); next ? i++ : i--)
				yield* traverse_children(node.childNodes[i]);
		}
		if (postorder)
			yield {node, open:!next};
	}
	if (!root.contains(node))
		throw Error("node must be root, or inside root");
	do {
		// children
		yield* traverse_children(node);
		if (node === root)
			return;
		// sibling
		const sibling = node[next ? "nextSibling" : "previousSibling"];
		if (sibling){
			node = sibling;
			yield* traverse_children(node);
			continue;
		}
		// parent
		node = node.parentNode;
		if (!fltr || fltr(node))
			yield {node, open:!next};
	} while (node !== root);
}

/** Detects if a set of ranges are bounded by a single composition boundary.
 * 	Used to detect if the browser is not respecting compositionborder=true
 * @param {[StaticRange] | [Range] | Selection} ranges ranges to check if they're bounded
 * @param root a root element that as an additional bounds constraint (e.g. the root contenteditable)
 * @returns false, if the range is not bounded; otherwise, it returns the boundary Range,
 * 	as given by `composition_boundary`
 */
function is_composition_bounded(ranges, root=document.body){
	if (ranges instanceof Selection)
		ranges = selection2ranges(ranges);
	if (!ranges.length)
		return false;
	// only need to calculate boundary for the first anchor, and then all the
	// remaining anchors we simply check if they are inside those bounds
	const bounds = composition_boundary(ranges[0].startContainer. ranges[0].startOffset);
	for (let r of ranges){
		if (r.compareBoundaryPoints(Range.START_TO_START, bounds) == -1 ||
			r.compareBoundaryPoints(Range.END_TO_END, bounds) == 1)
			return false;
	}
	return bounds;
}

/** This class will allow you to:
 * 	- revert the DOM to its state some point in the past
 * 	- see a range where DOM modifications occurred (utilizing RangeTracker)
 * 	- identify absolute plaintext positions (with caching mechanism for faster lookups, utilizing RangeTracker)
 * 	- track a list of plaintext edits, and retreive their corresponding ranges in the reverted DOM
 * 	
 * 	Unfortunately, MutationRecords provides limited state information. You can know what
 * 	the original parent node is, but the position in that parent is a point-in-time value given
 * 	by sibling node. So rather than put nodes directly back into their original positions, you have
 * 	no choice but to unroll all the childList mutations. In any case, the primary case for this
 * 	is compositions, which should only add/delete ~5 nodes in worst case, so not too bad.
 * 	
 * 	For a native browser implementation on the other hand, there is a way to directly reset nodes:
 * 	Keep an ordered Map(node => {parent, sibling, tied}). For newly added nodes, set {parent:null} to
 * 	indicate that a removal will undo this op. For removed nodes, search nextSibling's to find
 * 	a node that is not in the Map already, or null. Mark {parent, sibling} in the Map with that
 * 	sibling we found. Do not add a node twice to the Map. To undo, we iterate in reverse removing as we go:
 * 	- If parent is null, remove node
 * 	- If sibling exists in the Map still, then the sibling will be repositioned. We'll delegate the
 * 		node repositioning to sibling: push node to the end of sibling's "tied" list.
 * 	- Otherwise
 * 		- push node to "tied" list
 * 		- if sibling is null, append tied nodes to parent
 * 		- if sibling is not null, insert tied nodes before sibling
 * 	Unfortunately with MutationObserver, we can't examine the DOM at each mutation, only getting a
 * 	snapshot of the immediate nextSibling; so this algorithm can't be done from JavaScript.
 * 
 *	Another option for a native implementation is simply to cache childNodes whenever a parents child
 *	list is modified for the first time. For many mutations, this may be more efficient.
 * 
 * 	A similar technique can be used to provide better native browser implementation for calculating
 *	the range of modifications (with tighter bounds), or to improve the caching of plaintext absolute
 *	offsets. See the RangeTracker class
 */
class RevertDOM{
	// used for find plaintext offset lookups
	text_walker;
	// indicates clean node for plaintext offset cache
	plaintext_cache_anchor;
	// MutationObserver to track DOM changes
	observer;
	// plaintext edit log
	edit_list;
	/* Data/attribute mutations for each node
		node => {
			data: old character data
			attrs: { namespace:name => old value }
		}
	*/
	prop_mutations;
	/* This is an ordered list of operations need to undo each tree mutation: {
			nodes: list of nodes to operate on
			parent: parent to add to, or null if they should be removed
			before: insert nodes before this element (can be null)
		}
	*/
	tree_mutations;
	/* Similar to tree_mutations, but tracks additional information regarding 
		
	*/
	range_mutations;

	constructor(){
		this.text_walker = null;
		this.observer = new MutationObserver(this.#track_mutations.bind(this));
		this.prop_mutations = new Map();
		this.tree_mutations = [];
	}
	/** Start listening to mutations to a root element to revert the DOM later.
	 * 	Resets the structure to accumulate plaintext edits (see plaintext_edit method)
	 */
	start(root){
		// TODO: can reuse anchor if revert but don't stop
		plaintext_cache_anchor = null;
		if (this.text_walker?.root !== root)
			this.text_walker = document.createTreeWalker(root, NodeFilter.TEXT_NODE);
		this.observer.observe(this.root, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeOldValue: true,
			characterData: true,
			characterDataOldValue: true
		});
		const l = root.textContent.length;
		this.edit_list = [{edited:false, length:l, original_length:l}];
	}
	/** Stop listening to mutations and possibly revert the DOM;
	 * if DOM is reverted, a list of type [{range, data}] is returned giving
	 * the plaintext edits that occurred during composition
	 */
	stop(revert=false){
		if (revert)
			this.track_mutations(this.observer.takeRecords());
		this.observer.disconnect();
		if (revert){
			// Revert DOM ---------
			// data/attributes can be reverted unordered
			for (const [node,m] of this.prop_mutations.entries()){
				if ("data" in m)
					node.data = m.data;
				for (const attr in m.attrs)
					node.setAttribute(attr, m.attrs[attr]);
			}
			this.prop_mutations.clear();
			// move nodes to original positions
			let op;
			while (op = this.tree_mutations.pop()){
				if (!op.parent)
					op.nodes.forEach(n => n.remove());
				else if (!op.before)
					op.parent.append(...op.nodes);
				else
					op.before.before(...op.nodes);			
			}

			// build a list of edits in terms of the reverted DOM
			// TODO
		}
	}
	/** Mark a plaintext edit, as in text composition reported by beforeinput event
	 * @param range the range of data to be replaced
	 * @param data the new data to insert in that range
	 */
	plaintext_edit(range, data){

	}
	/** For a given anchor, return the absolute plaintext offset in root. This uses a caching
	 * 	mechanism to be O(1) on average.
	 * @param node anchor node; must be inside root
	 * @param {int} offset anchor offset inside node, in the manner of Range.start/endOffset
	 * @returns an object {raw, zws}, giving the absolute offset;
	 * 	zws has excluded any "zero width space" from the start/end of a textnode
	 * 	(used for emulating compositionborder=true)
	 */
	plaintext_offset(node, offset){
		// convert to a textnode lookup
		if (node.nodeType != Node.TEXT_NODE){
			this.text_walker.currentNode = node;
			node = this.text_walker.previousNode();
			if (!node)
				return 0;
			offset = node.length;
		}
		this.#update_plaintext_cache(
			(anchor, cache) => anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
			(anchor, cache) => anchor === node
		);
		const nc = node._revertdom_plaintext_cache;
		const starting_zws = node.data[0] === '\u200B';
		return {
			raw: nc.sum + offset,
			zws: nc.zws_sum + offset - starting_zws
		};
	}
	/** Given a plaintext offset, calculate its corresponding anchor position. This is an O(N)
	 * 	lookup in the number of text nodes, unlike plaintext_offset which is O(1). You can batch
	 * 	many offset lookups together for little additional cost.
	 * @param {[int]} offsets absolute plaintext offsets, such as one returned from `plaintext_offset`;
	 * 	must be sorted in ascending order; each offset must be between [0,root.textContent.length]
	 * @param {bool} zws whether offset excludes zero width spaces
	 * 	(used to emulate compositionborder)
	 * @returns Ordered list of {node, offset} anchors, each corresponding to an offset in
	 * 	the input list; node/offset suitable for use in Range. Where a plaintext offset is on
	 * 	the border of two text nodes, the following one in DOM tree order is returned.
	 */
	plaintext_anchors(offsets, zws){
		// cache up to the last offset
		const last = offsets.at(-1);
		const fulfills_request = (anchor, cache) => {
			if (zws)
				return cache.zws_sum + cache.zws_length >= last;
			return cache.sum + cache.length >= last;
		};
		this.#update_plaintext_cache(fulfills_request, fulfills_request);
		/** convert absolute offset to relative offset inside node; null if outside node */
		const relative_offset = (node, offset) => {
			// since we search backwards from the anchor, we don't
			// need to check > c.[zws_]length for returning null
			const c = node._revertdom_plaintext_cache;
			let rel;
			if (zws){
				rel = offset - c.zws_sum;
				if (rel < 0)
					return null;
				// ignore starting zero width space
				if (node.data[0] === '\u200B')
					rel++;
			}
			else{
				rel = offset - c.sum;
				if (rel < 0)
					return null;
			}
			return rel;
		};
		// while we can halve the search by starting search with anchor vs root,
		// for batched offset lookups, on average it's not going to matter; we'll
		// start from anchor since text edits are usually at the end
		const anchors = [];
		let node = this.plaintext_cache_anchor;
		this.text_walker.currentNode = node;
		for (let i=offsets.length-1; i>=0; i--){
			let offset;
			while (true){
				offset = relative_offset(node);
				if (offset === null)
					node = this.text_walker.previousNode();
				else break;
			}
			anchors.unshift({node, offset});
		}
		return anchors;
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
	 *	We store the cumulative sum cache in each node as:
	 *		_revertdom_plaintext_cache = {
	 *			length: node.data.length (primarily used by track_mutations method for dirty checks)
	 *			sum: sum of all text node lengths preceding this node, inside root
	 *			// for emulating compositionborder with zero width space
	 *			zws_length: cached zerowidthspace_length(node.data)
	 *			zws_sum: same as sum, but this time using zws_length
	 *		}
	 *
	 *	Note: could also consider building cache backwards from end instead of start;
	 *		though I think on average it doesn't make a difference
	 *
	 * @param start_condition callback(anchor, anchor._revertdom_plaintext_cache) -> bool;
	 * 	return true if having summations cached up to this anchor is sufficient (no cache updates will be made)
	 * @param stop_condition callback(anchor, anchor._revertdom_plaintext_cache) -> bool;
	 * 	return true if we should stop calculating the summation; note an error will be thrown
	 * 	if you don't stop the summation before the end of root
	 */
	#update_plaintext_cache(start_condition, stop_condition){
		const anchor = this.plaintext_cache_anchor;
		if (!anchor || start_condition(anchor, anchor._revertdom_plaintext_cache)){
			let sum, zws_sum, nxt;
			// recompute completely
			if (!anchor){
				sum = zws_sum = 0;
				this.text_walker.currentNode = this.root;
				nxt = this.text_walker.nextNode();
			}
			// extend summation
			else{
				const c = anchor._revertdom_plaintext_cache;
				sum = c.sum + c.length;
				zws_sum = c.zws_sum + c.zws_length;
				this.text_walker.currentNode = anchor;
				nxt = this.text_walker.nextNode();
			}
			while (true){
				if (!nxt)
					throw Error("assertion error: plaintext cache reached the end of root");
				const length = nxt.length;
				const zws_length = zerowidthspace_length(nxt);
				nxt._revertdom_plaintext_cache = {sum, zws_sum, length, zws_length};
				if (stop_condition(nxt, nxt._revertdom_plaintext_cache))
					break;
				sum += length;
				zws_sum += zws_length;
				nxt = this.text_walker.nextNode();
			}
			this.plaintext_cache_anchor = nxt;
		}
	}

	/** Returns a Range bounding the nodes whose DOM was changed, either by DOM insertion/removal,
	 * text changes, or attribute changes. Any node outside the range was unmodified. While we
	 * do some optimizations to tighten the bounds, this is not guaranteed to be the tightest bounds.
	 * E.g. if there are complex mutations that cancel eachother out, they probably won't get detected;
	 * In that case, the only practical option is DOM diffing. Still, the Range returned by this method
	 * can be useful as a boundary for DOM diffing.
	 *
	 * Since the Range boundary is in reference to the unmodified DOM nodes, the Range will be the
	 * same for the DOM when reverted.
	 *
	 * @returns null if DOM is unchanged, otherwise a Range giving the modification boundary
	 */
	mutated_range(){
		// For character and attribute changes, 
		const fr = null, 	  // full range of all mutations
			sr = new Range(); // range for single mutation
		/** union of sr with fr */
		function union(){
			if (!fr) fr = sr;
			else{
				if (fr.compareBoundaryPoints(Range.START_TO_START, sr) == 1)
					fr.setStart(sr.startContainer, sr.startOffset);
				if (fr.compareBoundaryPoints(Range.END_TO_END, sr) == -1)
					fr.setEnd(sr.endContainer, sr.endOffset);
			}
		}
		// attributes/data we can use the current node position
		for (const [n,m] of this.prop_mutations.entries()){
			if (root.contains(n) && ("data" in m || m.attrs.size)){
				sr.selectNode(n);
				union();
			}
		}
		// TODO: tree modifications


		return fr;
	}

	#ensure_prop_mutations(node){
		let m = this.prop_mutations.get(node);
		if (!m){
			m = {attrs: new Map()};
			this.prop_mutations.set(node, m);
		}
		return m;
	}
	#track_mutations(records){
		/* Mainly we are tracking how to revert the DOM, but we'll also reuse the mutation
			observer to track the range of modifications and allow some caching for plaintext
			absolute offset calculations (which is a lightweight alternative to a dedicated
			data structure like binary indexed tree).
		*/
		/* min/max clean node candidates from any modifcation;
			Each entry of the form:
				{ node: Node, open: bool}
			Which marks a candidate "clean" boundary point at the open (true) or close (false) of that node.
			The min/max boundary position in the current DOM gives the range where mutations occurred.
		*/
		const range_candidates = {min: [], max: []};
		// min dirty node candidates from plaintext modification;
		// if cache is empty (anchor null), no need to update it
		let plaintext_candidates = null;
		if (this.plaintext_cache_anchor)
			plaintext_candidates = [this.plaintext_cache_anchor];
		/* Log of mutations for identifying min/max range of mutations, and min boundary for plaintext mutations:
			node -> [
				length: bool, true if this is a textnode and its length changed
				data: bool, whether data has textnode data changed

				{
				add: bool, whether node was added or removed
				parent: previous parent (remove), or current parent (add)
				next/previous: previous next/previousSibling (remove), or current next/previousSibling (add)
			},...] at most two elements
			This is used to combine some adds/removes to give slightly tighter bounds for the modification
			range. Similar log to this.tree_mutations, except its tracking extra information, and the logic
			to merge mutations is different.
		*/
		const range_mutations = new Map();
		for (let r of records){
			const t = r.target;
			switch (r.type){
				case "characterData": {
					const m = this.#ensure_prop_mutations(t);
					if (!(data in m))
						m.data = r.oldValue;
					else if (t.data === m.data)
						delete m.data;
					// does this dirty the plaintext cache?
					// must have cached plaintext previously, and length must have changed
					const c = t._revertdom_plaintext_cache;
					if (plaintext_candidates && c && c.length != t.data.length){
						// some extra logic to prevent a duplicate node in plaintext_candidates
						if (t !== plaintext_candidates[0])
							plaintext_candidates.push(t);
						c.length = t.data.length;
					}
				} break;
				case "attributes": {
					let name = r.attributeName;
					if (r.attributeNamespace)
						name = r.attributeNamespace+':'+name;
					const m = this.#ensure_prop_mutations(t);
					if (!m.attrs.has(name))
						m.attrs.set(name, r.oldValue);
					else if (m.attrs.get(name) === m.getAttribute(name))
						m.attrs.delete(name);
					
				} break;
				case "childList":
					/* we can do some small optimizations to reduce the number of ops;
						we just do a 1 or 2 op lookback, but more than that I think is possible;
						the logic for 2+ is complicated, so probably not worth it
					*/
					if (r.addedNodes.length){
						// tree mutations; add becomes remove
						const nodes = new Set(r.addedNodes);
						const prev = this.tree_mutations.at(-1);
						// remove* + add = add (moving a node)
						move: if (prev){
							let add = prev;
							if (!add.parent){
								// remove + remove + add = add
								add = this.tree_mutations.at(-2);
								if (!add || !add.parent)
									break move;
							}
							for (const n of add.nodes)
								nodes.remove(n);
						}
						if (nodes.size){
							// union of remove + remove
							if (prev && !prev.parent){
								for (const n of r.addedNodes)
									prev.nodes.add(n);
							}
							else this.tree_mutations.push({ nodes, parent: null });
						}
					}
					if (r.removedNodes.length){
						// tree mutations; remove becomes add
						const nodes = new Set(r.removedNodes);
						const prev = this.tree_mutations.at(-1);
						if (prev){
							// add + remove cancel out
							if (!prev.parent){
								for (const n of prev.nodes){
									if (nodes.delete(n))
										prev.nodes.delete(n);
								}
								if (!prev.nodes.size){
									this.tree_mutations.pop();
									prev = this.tree_mutations.at(-1);
								}
							}
							/* add + add can combine in some cases;
								necessarily disjoint sets, since a node cannot have two add ops; remove must come in between
							*/
							if (prev && t === prev.parent && r.nextSibling === prev.before){
								for (const n of prev.nodes)
									nodes.add(n);
								prev.nodes = nodes;
								break;
							}
						}
						if (nodes.size){
							this.tree_mutations.push({
								nodes,
								parent: t,
								before: r.nextSibling
							});
						}
					}
					break;
			}
		}
		// incorporate  range/plaintext 
	}
};

/** Given a sequence of childList mutations (added/removed nodes), this
 * 	tracks the furthest extent in the DOM tree that those mutations went.
 * 	It can track either the furthest extent backward or forward. The method
 * 	of tracking can't give exact bounds of mutations, e.g. if you do some complex
 * 	DOM manipulation that reverts itself, but it can be useful to give you bounds
 * 	for more complex detection methods like DOM diffing, if desired.
 */
class RangeTracker{
	/* Add+remove can cancel out, but only if the node is not being used as a reference
		by another. Can keep a reference count, and every time a
		op cancels out, 
	*/
	history;

	/** Extend the range immediately to node. Use this for siblings
	 * whose attributes or text content was changed, and so don't need to be
	 * buffered.
	 */
	mark_immediate(node){

	}
	mark_buffered()
}

export function emulate_composition_proposals(editor){
	// for reverting the DOM after composition
	let revert_data;
	// tracks the edits made during composition
	let edit_list;
	// used to detect if Chrome goes outside the compositionborder elment
	let composition_target;
	// forces browser to commit the current composition
	let requested_end;
	function requestCompositionEnd(){
		// only need to run once per composition
		if (requested_end) return;
		requested_end = true;
		console.log("requesting composition end");
		editor.blur();
		editor.focus();
	}
	// initializes state
	editor.addEventListener("compositionstart", e => {
		composition_target = window.getSelection().focusNode;
		if (composition_target.nodeType == Node.TEXT_NODE)
			composition_target = composition_target.parentNode;
		console.log("starting composition inside: ", composition_target);
		revert_data = composition_target.textContent;
		const l = revert_data.length;
		edit_list = [{edited:false, length:l, original_length:l}];
		requested_end = false;
	});
	// enforces compositionborder in Chrome
	editor.addEventListener("compositionupdate", e => {
		const sel = window.getSelection();
		for (let ri=0; ri<sel.rangeCount; ri++){
			const r = sel.getRangeAt(ri);
			const p = composition_target.compareDocumentPosition(r.commonAncestorContainer);
			if (!(!p || p & Node.DOCUMENT_POSITION_CONTAINED_BY)){
				console.log(r.commonAncestorContainer, "is outside compositionborder", composition_target);
				requestCompositionEnd();
			}
		}
	});
	// tracks edits, adds requestCompositionEnd polyfill
	editor.addEventListener("beforeinput", e => {
		if (e.inputType == "insertCompositionText"){
			// polyfill for requesting end
			e.requestCompositionEnd = requestCompositionEnd;

			// assertions that must be true for this emulation to work
			const ranges = e.getTargetRanges();
			if (ranges.length != 1)
				throw Error("there should only be one target range");
			const range = ranges[0];
			if (!range.startOffset)
				throw Error("composition is probably multiword, and is crossing our zero-width space");
			const rs = range.startContainer, re = range.endContainer;
			if (rs.nodeType !== Node.TEXT_NODE || re.nodeType !== Node.TEXT_NODE)
				throw Error("target range is non-text based");
			if (rs.parentNode !== composition_target || re.parentNode !== composition_target)
				throw Error("composition created HTMLElements or went outside compositionborder element");

			// mark the edit	
			// convert to plaintext offsets (simple linear search)
			let el = composition_target.firstChild;
			let pt_start = 0;
			while (el !== rs){
				if (el.nodeType !== Node.TEXT_NODE)
					throw Error("composition created HTMLElements");
				pt_start += el.length;
			}
			let pt_end = pt_start + rs.length;
			pt_start += range.startOffset;
			while (el !== re){
				if (el.nodeType !== Node.TEXT_NODE)
					throw Error("composition created HTMLElements");
				pt_end += el.length;
			}
			pt_end -= re.length-range.endOffset;
			// merge with edit_list (again using linear search)
			let ei = 0;
			let sum = 0;
			let intersect_start = -1;
			const new_edit = {edited:true, length:0, original_length:0, data:""};
			while (true){
				let cur_edit = edit_list[ei];
				const sum_nxt = sum + cur_edit.length;
				next: {
					// find intersection start
					if (intersect_start == -1){
						if (pt_start >= sum_nxt)
							break next;
						// merge
						if (!cur_edit.edited){
							// split the unedited range at start
							if (pt_start != sum){
								const left = pt_start-sum;
								const right = cur_edit.length-left;
								cur_edit.length = cur_edit.original_length = left;
								const right_edit = {edited:false, length:right, original_length:right};
								edit_list.splice(++ei, 0, right_edit);
								sum += left;
								cur_edit = right_edit;
							}
						}
						else new_edit.data = cur_edit.data.substring(0,pt_start-sum);
						intersect_start = ei;
						// passthrough, to check if the end also intersects this range
					}
					new_edit.length += cur_edit.length;
					new_edit.original_length += cur_edit.original_length;
					// find intersection end
					if (pt_end > sum_nxt)
						break next;
					// TODO: double check this logic... think it needs to include data.length 
					new_edit.data += e.data;
					// merge
					let intersect_end = ei;
					if (!cur_edit.edited){
						// trim the unedited range at end
						if (sum_nxt != pt_end){
							let l = cur_edit.length = cur_edit.original_length = sum_nxt - pt_end;
							new_edit.length -= l;
							new_edit.original_length -= l;
							intersect_end--;
						}
					}
					else new_edit.data += cur_edit.data.substring(pt_end-sum);
					// replace intersection
					edit_list.splice(intersect_start, Math.max(0,intersect_end-intersect_start), new_edit);
					if (new_edit.data.length != new_edit.length)
						throw Error("assertion failed: cached data length should match cumulative length");
					break;
				}
				if (++ei == edit_list.length){
					// appending data case
					if (intersect_start != -1)
						throw Error("assertion failed: appending data should have no intersection");
					new_edit.data = e.data;
					new_edit.length = e.data.length;
					edit_list.push(new_edit);
					break;
				}
				sum = sum_nxt;
			}
		}
	});
	// handles DOM reversion
	editor.addEventListener("compositionend", e => {		
		// mimicking a reversion, which is good enough for this demo;
		// alternatively, could put this in a method revertComposition()
		const txt = new Text(revert_data);
		const mod = Array.from(composition_target.childNodes);
		composition_target.replaceChildren(txt);

		// convert edit_list to a list of ranges in reference to unmodified DOM;
		// simple in our case, since it is just a single TextNode; we'll also create
		// a merged "working range"
		const edits = [];
		let sum = 0;
		let unedited_start = 0;
		const working_range = new Range();
		let working_data = "";
		for (let edit of edit_list){
			let nxt_sum = sum + edit.original_length;
			if (edit.edited){
				// individual edits
				const range = new Range();
				range.setStart(txt, sum);
				range.setEnd(txt, nxt_sum);
				edits.push({ range, data: edit.data });
				// combined, single edit
				if (edits.length == 1)
					working_range.setStart(txt, sum);
				else{
					working_data += revert_data.substring(unedited_start, sum);
					working_range.setEnd(txt, nxt_sum);
				}
				working_data += edit.data;
				unedited_start = nxt_sum;
			}
			sum = nxt_sum;
		}

		// build a mock insertFromComposition event that behaves as we want
		let evt = new Event("beforeinput", {cancelable: true});
		evt.inputType = "emulated_insertFromComposition";
		evt.data = edits;
		evt.working_range = working_range;
		evt.working_data = working_data;
		composition_target.dispatchEvent(evt);

		// If event was not canceled, insert the composed text back into the node
		if (!evt.defaultPrevented)
			composition_target.replaceChildren(mod);
	});
}

