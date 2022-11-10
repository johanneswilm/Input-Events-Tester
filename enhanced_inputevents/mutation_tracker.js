import { MutatedRange } from "./mutated_range.js";

/** Tracks mutations performed on the DOM, allowing DOM to be reverted to its
 * 	initial state, or a Range to be queried with the extent of DOM mutations.
 * 
 * 	Tracking is optimal, in that we only store the delta between the original and current
 * 	DOM. Reverting the DOM can be done directly, without needing to unwind a log of all
 * 	mutations. Additionally, mutation range queries give exact bounds, and can detect
 * 	when mutations cancel out.
 * 
 * 	The interface is designed to take input from MutationObserver, but this is up to the
 * 	user. Tracking a delta rather than log of mutation records is a bit tricky to do while
 * 	supporting the batched, async MutationObserver interface: we build a cached view of
 * 	the current and original DOM's sibling graph; the full DOM is not cached, just the
 * 	parts necessary for tracking. So there is a bit more overhead than simply logging
 * 	mutation records. Nevertheless, this method gives optimal worst case behavior, and
 * 	gives exact bounds for mutations, so I think is better for most cases.
 * 
 * 	You can get the raw delta by accessing this.props (node property changes) and
 * 	this.floating (DOM tree changes). The structure of these may change in the future,
 * 	so if you access these, just make sure to use an exact version number.
 */
export class MutationTracker{
	constructor(){
		// Node property changes: node => PropertyCache
		this.props = new Map();
		// Node position changes
		this.tree = new TreeMutations();
	}

	/** Add the changes indicated by a MutationRecord. Note for attributes and
	 * 	characterData records, you need to include the old value
	 * @param {MutationRecord} r
	 */
	record(r){
		switch (r.type){
			case "attributes":
				let name = r.attributeName;
				if (r.attributeNamespace)
					name = r.attributeNamespace+':'+name;
				this.attribute(r.target, name, r.oldValue);
				break;
			case "characterData":
				this.data(r.target, r.oldValue);
				break;
			case "childList":
				this.children(r.removedNodes, r.addedNodes, r.target, r.previousSibling, r.nextSibling);
				break;
		}
	}

	/** Indicate nodes added or removed as children of some parent node
	 * @param {[Node]} removed an ordered list of nodes that were removed
	 * @param {[Node]} added an ordered list of nodes that were added
	 * @param {Node} parent parent node where removal/insertion occurred
	 * @param {Node | null} prev point-in-time previousSibling of the removed/added nodes
	 * @param {Node | null} next point-in-time nextSibling of the removed/added nodes
	 */
	children(removed, added, parent, prev, next){
		this.tree.mutation(removed, added, parent, prev, next);
	}	

	/** Shared method for tracking attribute and data changes */
	#prop(node, mode, key, value, old_value){
		let props = this.props.get(node);
		if (!props){
			props = new PropertyCache();
			this.props.set(node, props);
		}
		props.mark(mode, key, value, old_value)
	}
	/** Indicate HTML attribute changed. Note this uses the current node.getAttribute
	 * 	value for detecting when the attribute is modified.
	 * @param {Node} node node whose attribute changed
	 * @param {String} key namespace qualified attribute name, e.g. "namespace:name"
	 * @param old_value previous value of this attribute; when attribute is first seen, this is
	 * 	stored as the "original value", and used to detect when the attribute reverts
	 */
	attribute(node, key, old_value){
		return this.#prop(node, "native", key, node.getAttribute(key), old_value);
	}
	/** Indicate data change for a CharacterData node. Note this uses the current node.data
	 * 	value for detecting when the text is modified.
	 * @param {Node} node node whose data (text content) changed
	 * @param old_value previous text content; when this node's text is first seen, this is
	 * 	stored as the "original value", and used to detect when the text reverts
	 */
	data(node, old_value){
		// we use null as the key for data
		return this.#prop(node, "native", null, node.data, old_value);
	}
	/** Indicate some custom property for the node has changed. Custom properties are not
	 * 	automatically reverted; you must provide a callback to revert them yourself, see `revert()`
	 * @param {Node} node node whose property changed
	 * @param key any Map capable object
	 * @param value current value for this property; this can be the value several mutations
	 * 	after `old_value` was read, as would be the case for MutationRecords
	 * @param old_value previous value of this property; when property is first seen, this is
	 * 	stored as the "original value", and used to detect when the property reverts
	 */
	property(node, key, value, old_value){
		return this.#prop(node, "custom", key, value, old_value);
	}

	/** Check if DOM is mutated
	 * @param {Node} root Filter for mutations that are inside root; useful when using MutationObserver, which
	 * 	in certain situations can track mutations outside of its root node
	 * @returns {Boolean} true if DOM is different from how it started
	 */
	mutated(root=null){
		if (root){
			for (const [node,props] of this.props.entries())
				if (props.dirty && root.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_CONTAINED_BY)
					return true;
			for (const op of this.tree.floating.values()){
				// we can just check parent here; parent == root is okay
				if (op.original.parent && root.contains(op.original.parent) || op.node.parentNode && root.contains(op.node.parentNode))
					return true;
			}
			return false;
		}
		if (this.tree.floating.size)
			return true;
		for (let props of this.props.values())
			if (props.dirty)
				return true;
		return false;
	}
	/** Get a Range indicating bounds of the mutated parts of the DOM. You must call this prior
	 * 	to `revert`, since reverting resets tracking.
	 * @param {Node} root Filter for mutations that are inside root; useful when using MutationObserver, which
	 * 	in certain situations can track mutations outside of its root node
	 * @returns {MutatedRange | null} null if the DOM is not mutated; MutatedRange can be collapsed, which
	 * 	indicates nodes have been removed at that position.
	 * @throws If root is false and mutations affect disconnected DOM trees, there would be multiple
	 * 	disconnected ranges for the mutations; an error is thrown in this case. Node movements to
	 * 	an "orphaned" DOM are not included in the range, so will not generate this error; examples
	 * 	are a node that is newly added (no prior DOM), or a node is removed (no current DOM). In the
	 * 	case of an error, specify `root` parameter, which could simply be the `document` of interest.
	 */
	range(root=null){
		let fr = null, // full range of all mutations
			sr = new MutatedRange(); // range for single mutation
		/** Union of fr with sr */
		const union = () => {
			if (fr === null)
				fr = sr.cloneRange();
			else fr.extend(sr);
		};
		/** Include node that is inside root */
		const include = (node) => {
			return !root || root.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_CONTAINED_BY;
		};
		for (const [node,props] of this.props.entries()){
			if (props.dirty && include(node)){
				sr.selectNode(node);
				union();
			}
		}
		for (const op of this.tree.floating.values()){
			// current position
			if (op.node.parentNode && !this.props.get(op.node)?.dirty && include(op.node)){
				sr.selectNode(op.node);
				union();
			}
			/* Original position: Only care about fixed nodes when marking the original bounds.
				If prev/next bounds have been moved, then the bounds get extended to *their* siblings,
				so we delegate the bound extension to those siblings instead. Eventually, a fixed
				node will be found that is a candidate.
			*/
			if (!op.original)
				continue;
			op = op.original;
			const p = op.parent;
			if (p){
				const prev_fixed = !op.prev || !this.floating.has(op.prev);
				const next_fixed = !op.next || !this.floating.has(op.next);
				if (!prev_fixed && !next_fixed)
					continue;
				// parent == root okay in this case
				if (root && !root.contains(p))
					continue;
				// if we only have one side, we collapse; the other side will be handled later by another node
				if (prev_fixed)
					sr.setStart(op.prev || p, Boolean(op.prev), !next_fixed);
				if (next_fixed)
					sr.setEnd(op.next || p, Boolean(op.next), !prev_fixed);
				union();
			}
		}
		return fr;
	}

	/** Revert the DOM to its original state. This also has yields the effects of `clear()`.
	 * As noted in `clear()` you may wish to reattach a corresponding MutationObserver.
	 * @param custom_revert fn(node, key, value), which is called for all custom properties
	 * 	that were set (see `property()`), and should be used to revert that custom value
	 */
	revert(custom_revert=null){
		// TODO: `root` option
		// revert properties
		for (const [node,props] of this.props.entries())
			props.revert(node, custom_revert);
		this.props.clear();
		// revert DOM positions
		/* Order of node movements can matter:
			1. If a node will be inserted next to a sibling, but that sibling is floating, the sibling
				needs to be resolved first. We can easily handle this by linking up nodes by their
				prev/next siblings and inserting them as a group.
			2. The order we process parents matters when an ancestor has become a descendant of its
				descendant. In this case you'll get an error, "new child is an ancestor of the parent"
				Determining the ordering of parents is complex, since we need to check descendants/ancestors
				both in the current position, and possibly in the new position. I cannot think of an efficient
				algorithm to do it currently. An alternative is simply to remove those descendants first
				(which is feasible, albeit with non-negligble overhead), thus severing the problematic ancestor
				connection. An even simpler alternative is just to remove all floating nodes. Every node
				insertion requires a removal first, so this is what the browser is going to do anyways. The only
				reason to try to discover the parent ordering is to optimize a remove+append into a single
				append. Given the complexity of computing the parent ordering, the overhead for that does
				not seem worth it; even determining *which* parents should be removed is costly. So we'll just
				remove all nodes to make parent ordering irrelevant.

				It could actually save time as well, since it reduces the amount of hierarchy checks the browser
				has to do on its end.
		*/
		for (const op of this.tree.floating.values()){
			let node = op.node;
			op = op.original;
			// remove nodes to handle ancestor-child ordering
			node.remove();
			if (!op){
				this.tree.floating.delete(node);
				continue;
			}
			const linked = [node];
			op.linked = linked;
			// walk through prev/next and link up any ones that are floating as well
			const link_siblings = (dir, arrfn) => {
				arrfn = linked[arrfn].bind(linked);
				let bop = op, bop_next, link;
				while (true){
					if (!(link = bop[dir]) || !(bop_next = this.tree.floating.get(link))){
						// inherit the linked ops prev/next
						op[dir] = link;
						break;
					}
					// we'll take over handling the node
					this.tree.floating.delete(link);
					arrfn(link);
					// remove nodes to handle ancestor-child ordering
					link.remove();
					bop = bop_next.original;
				}
			}
			link_siblings("prev", "unshift");
			link_siblings("next", "push");
		}
		/* If nodes are already inside the correct parent, you could reduce the number of moves. E.g. [BCA],
			assuming all have moved, can be optimized to a single movement of A, rather than setting child
			list to [ABC]. Another might be combining two inserts into one by reinserting any nodes between,
			e.g. [AB],CD,[EF] -> [ABCDEF]. However, I think detecting this kind of optimization will end up
			being more computation than just moving all the children. So we won't optimize node ops any further.
		*/
		// perform node movements
		for (let op of this.tree.floating.values()){
			op = op.original;
			if (op.next)
				op.next.before(...op.linked);
			else op.parent.append(...op.linked);
		}
		this.tree.clear();
	}

	/** Clear the internal log of mutations, effectively "committing" the current DOM.
	 * You may also wish to reattach a corresponding MutationObserver, as it can track
	 * DOM nodes outside root. After clearing/reverting, these disconnected trees do
	 * not matter anymore.
	 */
	clear(){
		this.props.clear();
		this.tree.clear();
	}

	/** For memory optimization: Returns a value indicating the size of internal storage for
	 * tracking the mutations. You could use this to trigger periodic reversion/clearing or
	 * other mutation processing to keep memory low.
	 */
	get storage_size(){
		return this.props.size + this.tree.size;
	}
	/** For memory optimization: Signals that all mutations have been recorded and the view
	 * of the DOM given to MutationTracker is up-to-date with the current DOM. This would
	 * be the case after MutationObserver.takeRecords has been called, for example. This
	 * allows us to release some cached information about data/attributes/properties. If
	 * you will call revert/clear immediately, then there is no need to call synchronize.
	 */
	synchronize(){
		for (let [node,props] of this.props.entries()){
			if (!props.cleanup())
				this.props.delete(node);
		}
	}
}

/* Holds a record of mutations for attributes, character data, or custom properties.
 * With MutationRecord, we only get the oldValue, and need to fetch current value from getAttribute/data get.
 * The lack of point-in-time value means we cannot know if the value is reverted at that point-in-time. We only
 * are aware of a reversion *after the fact* (e.g. a new MutationRecord.oldValue matches what we had cached).
 * So unfortunately this means we'll need to cache oldValue in perpetuity, even when the property is reverted.
 * 
 * You can use cleanup method to remove all reverted properties, but this should only be done if you
 * are sure all MutationRecords have been accounted for already, and the PropertyCache has an accurate
 * view of the current DOM (e.g. when MutationObserver.takeRecords() is called).
 */
class PropertyCache{
	constructor(){
		/* Each in the form: key => {value, dirty}, where dirty indicates if the value
			is different than current and needs to be reverted. Native is for attributes
			and data, with a null key indicating data. Custom is for custom user defined
			properties.
		*/
		this.native = new Map();
		this.custom = new Map();
		// number of clean/dirty properties
		this._clean = 0;
		this._dirty = 0;
	}
	// Total size of the cache
	get size(){ return this.native.size + this.custom.size; }
	// Number of dirty properties
	get dirty(){ return this._dirty; }
	// Number of clean properties
	get clean(){ return this._clean; }
	/** Mark a property for the cache
	 * @param mode "native" for attribute/data, or "custom" for custom properties
	 * @param key the attribute name, null for data, or the custom property key
	 * @param value current value, which may be several mutations ahead of old_value
	 * @param old_value previous point-in-time value
	 */
	mark(mode, key, value, old_value){
		const m = this[mode];
		const props = m.get(key);
		// unseen property
		if (!props){
			const dirty = value !== old_value;
			m.set(key, {value: old_value, dirty});
			if (dirty)
				this._dirty++;
			else this._clean++;
		}
		// previously cached; just update dirty flag
		else{
			const dirty = value !== props.value;
			if (dirty != props.dirty){
				const change = dirty ? 1 : -1;
				this._dirty += change;
				this._clean -= change;
			}
		}
	}
	/** Removes clean properties from the cache, returning a count of dirty properties left */
	cleanup(){
		for (const [attr,o] of this.native.values())
			if (!o.dirty)
				this.native.delete(attr);
		for (const [key,o] of this.custom.values())
			if (!o.dirty)
				this.custom.delete(key);
		this._clean = 0;
		this._dirty = this.size;
		return this._dirty;
	}
	/** Reset all dirty properties for a node
	 * @param node the node to revert properties for
	 * @param custom_revert fn(node, key, value) callback, which can
	 * 	revert custom user properties
	 */
	revert(node, custom_revert){
		for (const [attr,o] of this.native.entries()){
			if (!o.dirty)
				continue;
			if (attr === null)
				node.data = o.value;
			else if (o.value === null)
				node.removeAttribute(attr);
			else node.setAttribute(attr, o.value);
		}
		if (custom_revert){
			for (const [key,o] of props.custom){
				if (o.dirty)
					custom_revert(node, key, o.value);
			}
		}
	}
}

/** Container to encapsulate mutations to the DOM tree (node adds/removes) */
class TreeMutations{
	constructor(){
		this.floating = new Map(); // node => MutatedNode
		this.original = new SiblingIndex("original");
		this.mutated = new SiblingIndex("mutated");
	}

	/** Remove all mutations */
	clear(){
		this.floating.clear();
		this.original.clear();
		this.mutated.clear();
	}

	/** Storage size for mutations */
	get size(){ return this.floating.size; }

	/** Add a mutation to the tree
	 * @param {[Node]} removed an ordered list of nodes that were removed
	 * @param {[Node]} added an ordered list of nodes that were added
	 * @param {Node} parent parent node where removal/insertion occurred
	 * @param {Node | null} prev point-in-time previousSibling of the removed/added nodes
	 * @param {Node | null} next point-in-time nextSibling of the removed/added nodes
	 */
	mutation(removed, added, parent, prev, next){
		if (!removed.length && !added.length)
			return;
		// whether to try to propagate fixedness of `anchors`
		const propagate = false;
		// candidates is a list of MutatedNodes we can propagate fixedness to; can be empty
		const candidates = [];
		// anchor nodes marking fixedness propagation points (prev/next indicate corresponding sides of candidates)
		const anchors = { prev: null, next: null };
		const ensure_anchors = () => {
			if (!anchors.prev)
				anchors.prev = this.#anchor_siblings(prev, parent, "prev", "next", true);
			if (!anchors.next)
				anchors.next = this.#anchor_siblings(next, parent, "next", "prev", true);
		};

		/* TODO: Technically the removes and adds can happen in any order, and an added node
			can be inserted next to any of the removed nodes. So long as final added ordering
			remains the same, it is fine. The only side case is when a node needs to be removed
			and then readded. I'm wondering if there might be some assumptions you could make
			to maximize the number of fixed nodes. Right now the fixedness check assumes all
			removed nodes are removed first, then after all the adds; so its only propagating
			fixedness from the ends.
		*/

		// REMOVED
		if (removed.length){
			const fixed = [];
			for (const node of removed){
				let mn = this.floating.get(node);
				// (fixed) newly removed; we calculate original positions in batch later
				if (!mn){
					mn = new MutatedNode(node);
					fixed.push(mn);
					this.floating.set(node, mn);
				}
				// (floating) previously moved node
				else{
					this.mutated.remove(mn);
					// add + remove cancel out
					if (!mn.original)
						this.floating.delete(node);
					else{
						mn.mutated = null;
						propagate |= mn.original.parent === parent;
					}
				}
			}
			// compute original siblings for newly removed nodes
			propagate |= fixed.length;
			const l = fixed.length-1;
			for (let fi=0; fi<=l; fi++){
				const fprev = fi != 0;
				const fnext = fi != l;
				const mn = fixed[fi];
				mn.original = {
					parent,
					prev: this.#original_sibling(mn.node, fprev ? fixed[fi-1].node : prev, fprev, parent, "prev", "next", anchors),
					next: this.#original_sibling(mn.node, fnext ? fixed[fi+1].node : next, fnext, parent, "next", "prev", anchors)
				};
				this.original.add(mn);
			}
		}

		// ADDED
		if (added.length){
			for (const node of added){
				const mn = this.floating.get(node);
				// newly added
				if (!mn){
					mn = new MutatedNode(node);
					this.floating.set(node, mn);
				}
				else{
					// an add + add will never happen with MutationObserver, but just in case user is doing
					// something funny, we'll remove any existing sibling links
					this.mutated.remove(mn);
					// returned to original parent, candidate for becoming fixed
					if (mn.original.parent === parent)
						candidates.push(mn);
				}
				// for nodes that are now reverted, this is unnecessary; doing unconditionally for simpler logic
				mn.mutated = {
					parent,
					prev: added[ai-1] || prev,
					next: added[ai+1] || next
				};
				this.mutated.add(mn);
			};
			propagate |= candidates.length;
		}
		
		// Check if these nodes have returned to original position (floating to fixed);
		// when checking fixedness, we ignore all nodes that would get moved to a different parent.
		if (propagate){
			// to become fixed there must be a fixed anchor we attach to on at least one side
			ensure_anchors();
			// no fixed reference, or nothing to propagate to?
			const prev_float = anchors.prev.floating;
			const next_float = anchors.next.floating;
			if (prev_float && next_float || !candidates.length && prev_float == next_float)
				return;
			// propagate from prev side
			const next_fixed = anchors.next.fixed;
			let next_end_idx = 0;
			if (!prev_float){
				next_end_idx = this.#propagate_fixedness(
					candidates, 0, candidates.length, parent,
					anchors.prev.fixed, next_float, Boolean(next_fixed), "next", "prev"
				);
				// no need to check next side
				if (next_end_idx === null)
					return;
			}
			// propagate from next side
			if (!next_float){
				// null for fixed argument, since we already processed the prev side
				this.#propagate_fixedness(
					candidates, candidates.length-1, next_end_idx-1, parent,
					next_fixed, null, null, "prev", "next"
				);
			}
		}
	}

	/** Find "anchor" siblings (see return value for description)
	 * @param {Node | null} node node to start search at
	 * @param {Node} parent parent of `node`
	 * @param {"next" | "prev"} forward_dir "next" or "prev", indicating which siblings we want to look for
	 * @param {"prev" | "next"} backward_dir opposite of forward_dir, the siblings we don't want
	 * @param {Boolean} stop_floating stop early when we find the "floating" type sibling
	 * @returns {{fixed: Node | null | undefined, proper: MutatedNode | null}} Two types of anchor nodes
	 * 
	 * 	- fixed : the first fixed sibling (in original position); undefined if `stop_floating`
	 * 		flag was set, and a proper anchor was found first
	 * 	- floating: the first floating sibling (moved) that is in its correct original parent
	 * 		(e.g. original parent matches `parent`); null if fixed anchor was found first
	 */
	#anchor_siblings(node, parent, forward_dir, backward_dir, stop_floating){
		const graph = this.mutated[backward_dir];
		let floating = null;
		// null (no sibling) is considered a fixed reference
		if (!node)
			return {fixed: null, floating};
		// node is fixed
		let mn = graph.get(node);
		if (!mn)
			return {fixed: node, floating};
		// traverse graph until no sibling can be found;
		// the final MutatedNode's sibling is the fixed one
		while (true){
			if (!floating && mn.original?.parent === parent){
				floating = mn;
				if (stop_floating)
					return {floating};
			}
			const fixed = mn.mutated[forward_dir];
			const mn_sibling = fixed ? graph.get(mn.node) : null;
			if (!mn_sibling)
				return {fixed, floating};
			mn = mn_sibling;
		}
	}

	/** Find the original sibling for a node before mutations occurred
	 * @param {Node} node node we want to find a sibling for
	 * @param {Node | null} sibling current `forward_dir` sibling of `node`
	 * @param {Boolean} fixed_hint true if we know that `sibling` is fixed, which can save a
	 * 	traversal to find th o riginal sibling
	 * @param {Node} parent parent of `node`
	 * @param {"next" | "prev"} forward_dir "next" or "prev", indicating which siblings we want to look for
	 * @param {"prev" | "next"} backward_dir opposite of `forward_dir`, the siblings we don't want
	 * @param anchors an object to store results of any `anchor_siblings()` call to be reused later;
	 * 	if an original sibling is not currently indexed, and no hint is given, we must traverse the
	 * 	mutated graph to find one
	 * @returns {Node | null} the original sibling
	 */
	#original_sibling(node, sibling, fixed_hint, parent, forward_dir, backward_dir, anchors){
		// original recorded by another node op already
		const oprev = this.original[backward_dir].get(node);
		if (oprev)
			return oprev.node;
		// otherwise, first fixed sibling is the original sibling
		if (fixed_hint)
			return sibling;
		let a = this.#anchor_siblings(sibling, parent, forward_dir, backward_dir, false);
		anchors[forward_dir] = a;
		return a.fixed;
	}

	/** Propagate a fixed anchor node to siblings if the siblings are correct. We
	 * 	ignore siblings in between that are not in their original parent.
	 * @param {[MutatedNode]} candidates candidates for becoming fixed; these are a
	 * 	sequence of nodes which all are in the correct parent, but perhaps not correct
	 * 	position; may be an empty list, and fixedness will be propagated just from
	 * 	`fixed` to `floating`
	 * @param {Number} idx integer index of candidate to start with
	 * @param {Number} end_idx integer index of candidate to end with; can equal idx;
	 * 	can be less than idx, indicating we should iterate candidates in reverse
	 * @param {Node} parent parent node of candidates
	 * @param {Node | null} fixed fixed reference to propagate from; sibling of the idx candidate
	 * @param {MutatedNode | null} floating floating node on the opposite side of `fixed`,
	 * 	which we can continue propagation if needed; the end_idx sibling
	 * @param {Boolean} floating_last `floating` is known to be the last node before a fixed one,
	 * 	so we shouldn't traverse further
	 * @param {"next" | "prev"} forward_dir propagation direction
	 * @param {"prev" | "next"} backward_dir opposition of forward_dir
	 * @returns {Number | null} idx we could not propagate to, or null if all candidates were made fixed
	 */
	#propagate_fixedness(candidates, idx, end_idx, parent, fixed, floating, floating_last, forward_dir, backward_dir){
		let mn;
		// mark a node as fixed and remove from the graph 
		const mark_fixed = () => {
			fixed = mn.node;
			this.floating.delete(fixed);
			this.original.remove(mn);
			this.mutated.remove(mn);
		};
		// first propagate to candidates
		const inc = Math.sign(end_idx-idx);
		for (; idx != end_idx; idx += inc){
			mn = candidates[idx];
			// can try from other side instead
			if (mn.original[backward_dir] !== fixed)
				return idx;
			mark_fixed();
		}
		// all candidates reverted, propagate beyond to pre-existing nodes
		mn = floating;
		if (mn){
			while (true){
				if (mn.original[backward_dir] !== fixed) 
					break;
				mark_fixed();
				// no need to look for more nodes
				if (floating_last)
					return null;
				// here we filter out nodes which are not in the correct parent
				do {
					// sibling is null (end of container), can stop
					if (!mn.mutated[forward_dir])
						return null;
					mn = this.mutated[backward_dir].get(mn.node);
					// sibling is fixed, can stop
					if (!mn)
						return null;
				} while (mn.original?.parent !== parent);
			}
		}
		return null;
	}
}

/** Container for a node's position change */
class MutatedNode{
	constructor(node){
		this.node = node;
		// null indicates untracked DOM position (e.g. detached from DOM tree, or in
		// a DOM tree whose mutations are not being observed)
		this.original = null;
		this.mutated = null;
	}
}

/** Indexes MutatedNodes by their prev/next sibling */
class SiblingIndex{
	/** Create a new index
	 * @param {"original" | "mutated"} mode which siblings to index on
	 */
	constructor(mode){
		this.mode = mode;
		// null siblings are not unique, so aren't indexed
		this.prev = new Map(); // MutatedNode[mode].prev -> MutatedNode
		this.next = new Map(); // MutatedNode[mode].next -> MutatedNode
	}
	/** Remove a nodes siblings from the index
	 * @param {MutatedNode} node 
	 */
	remove(node){
		const op = node[mode];
		if (!op) return;
		if (op.prev)
			this.prev.delete(op.prev);
		if (op.next)
			this.next.delete(op.next);
	}
	/** Add a nodes siblings to the index
	 * @param {MutatedNode} node 
	 */
	add(node){
		const op = node[mode]
		if (!op) return;
		if (op.prev)
			this.prev.set(op.prev, node);
		if (op.next)
			this.next.set(op.next, node);
	}
	/** Remova all siblings from index */
	clear(){
		this.prev.clear();
		this.next.clear();
	}
}