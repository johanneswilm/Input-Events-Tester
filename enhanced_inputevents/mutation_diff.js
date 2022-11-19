import { MutatedRange } from "./mutated_range.js";

/** Tracks mutations performed on the DOM, giving you the delta between original and mutated
 * 	DOM, allowing DOM to be reverted to its initial state, or a Range to be queried with the
 * 	extent of DOM mutations.
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
 */
export class MutationDiff{
	constructor(){
		// Node property changes: node => PropertyCache
		this.props = new Map();
		// Node position changes
		this.tree = new TreeMutations();
	}

	/** Add the changes indicated by a MutationRecord. Note for attributes and
	 * 	characterData records, you need to include the old value
	 * @param {MutationRecord} r the record to add
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
				this.children(r.target, r.removedNodes, r.addedNodes, r.previousSibling, r.nextSibling);
				break;
		}
	}

	/** Indicate nodes added or removed as children of some parent node
	 * @param {Node} parent parent node where removal/insertion occurred
	 * @param {[Node]} removed an ordered list of nodes that were removed
	 * @param {[Node]} added an ordered list of nodes that were added
	 * @param {Node | null} prev point-in-time previousSibling of the removed/added nodes
	 * @param {Node | null} next point-in-time nextSibling of the removed/added nodes
	 */
	children(parent, removed, added, prev, next){
		this.tree.mutation(parent, removed, added, prev, next);
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
	custom(node, key, value, old_value){
		return this.#prop(node, "custom", key, value, old_value);
	}

	/** Check if DOM is mutated
	 * @param {Node} root Filter for mutations that are inside root; useful when using MutationObserver, which
	 * 	in certain situations can track mutations outside of its root node
	 * @returns {Boolean} true if DOM is different from how it started
	 */
	mutated(root=null){
		if (root){
			for (const [node,props] of this.props.entries()){
				// if node was moved out of root, then we'll catch that later in the tree mutations
				if (props.dirty && root.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_CONTAINED_BY)
					return true;
			}
			for (const op of this.tree.mutations()){
				// we can just check parent here; parent == root is okay;
				// if root has been affected, at least one parent out of all mutations will still be contained in root
				if (op.original && root.contains(op.original.parent) || op.node.parentNode && root.contains(op.node.parentNode))
					return true;
			}
			return false;
		}
		if (this.tree.size)
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
		const fixed_sibling = (s) => {
			return s !== undefined && !(s instanceof SiblingPromise) && (s === null || !this.tree.has(s));
		};
		for (let op of this.tree.mutations()){
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

				const prev_fixed = fixed_sibling(op.prev);
				const next_fixed = fixed_sibling(op.next);
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

	// bitmask definitions for `diff()`
	static ALL			= 0xFFFF;
	static MUTATED		= 0b10000;
	static ORIGINAL		= 0b100000;
	static PROPERTY		= 0b111;
	static DATA			= 0b1;
	static ATTRIBUTE	= 0b10;
	static CUSTOM		= 0b100;
	static CHILDREN		= 0b1000;

	/** Get the current diff.
	 * @param filter a bitmask for which differences to return, which can be a combination of:
	 * 	- `ALL`: include all diff info
	 * 	- `MUTATED`: include the mutated (current) values
	 * 	- `ORIGINAL`: include the original values
	 * 	- `PROPERTY`: include attribute, data, and custom property changes
	 * 	- `DATA`: include data changes, see `data()`
	 * 	- `ATTRIBUTE`: include attribute changes, see `attribute()`
	 * 	- `CUSTOM`: include data changes, see `custom()`
	 * 	- `CHILDREN`: include node position changes, see `children()`
	 * 
	 * These are available as attributes on the MutationDiff class.
	 * @param custom_getter `fn(node, key)`, which is called to get the mutated value for custom
	 * 	properties; if not provided, the mutated value will not be set
	 * @returns {Map<Node, {data, attribute: {}, custom: Map, children}>} A Map giving the changes
	 *  for each node. An object `{original, mutated}` gives the original and/or mutated values for
	 *  each of the diff types. The mutated values are not stored for property mutations, so when
	 *  the mutated values are requested, it will query the current DOM for the value.
	 * 
	 *  For `attribute`, it is an Object mapping each attribute key to the diff; likewise for
	 *  `custom`, only using a Map to handle custom keys.
	 * 
	 *  The `children` diff gives the node's position change from a call to `children()`; the value
	 *  is an object giving the reference position with `parent` (parentNode), `next` (nextSibling),
	 *  and `prev` (previousSibling). The parent may be null if the node is not present in the
	 *  original/mutated DOM. The next/prev values may be undefined or a `SiblingPromise` if they
	 * 	are unknown. Calling `synchronize()` can resolve unknown node positions.
	 * 
	 * 	Each of the diff types may be absent if there was no difference, or it was not included
	 * 	in the filter. The output may be freely modified, as it is a copied view. For performance,
	 * 	you may consider accessing the raw internal mutation data instead, but I will not guarantee
	 * 	backward compatibility for the internal format.
	 */
	diff(filter=MutationDiff.ALL, custom_getter){
		/* We could mirror this format for the internal structure, possibly as its own class with
			access methods and all. The advantage being we could just return it mostly in its raw
			form with minimal reformatting. The problem though is JavaScript doesn't let you specify
			friend classes, so user would have full access to modify and possibly corrupt the
			internal state. Seems like you'd need to clone no matter what, so this would be as good
			as any
		*/
		const out = new Map();
		const FORIGINAL = filter & MutationDiff.ORIGINAL;
		const FMUTATED = filter & MutationDiff.MUTATED;
		if (FORIGINAL || FMUTATED){
			// diffs from PropertyCache
			if (filter & MutationDiff.PROPERTY){
				for (const [node, cache] of this.props.entries()){
					if (!cache.dirty)
						continue;
					let has_diff = false;
					const log = {};
					// data
					if (filter & MutationDiff.DATA){
						const op = cache.native.get(null);
						if (op && op.dirty){
							has_diff = true;
							const d = log.data = {};
							if (FORIGINAL)
								d.original = op.value;
							if (FMUTATED)
								d.mutated = node.data;
						}
					}
					// attributes
					if (filter & MutationDiff.ATTRIBUTES){
						let has_attrs = false;
						const attrs = {};
						for (const [key, op] of cache.native.entries()){
							if (!op.dirty || key === null)
								continue;
							has_attrs = true;
							const d = attrs[key] = {};
							if (FORIGINAL)
								d.original = op.value;
							if (FMUTATED)
								d.mutated = node.getAttribute(key);
						}
						if (has_attrs){
							log.attribute = attrs;
							has_diff = true;
						}
					}
					// custom properties
					if (filter & MutationDiff.CUSTOM){
						const custom = new Map();
						for (const [key, op] of cache.custom.entries()){
							if (!op.dirty)
								continue;
							const d = {};
							custom.set(key, d);
							if (FORIGINAL)
								d.original = op.value;
							if (FMUTATED && custom_getter)
								d.mutated = custom_getter(node, key);
						}
						if (custom.size){
							log.custom = custom;
							has_diff = true;
						}
					}
					if (has_diff)
						out.set(node, log);
				}
			}
			// diffs from TreeMutations
			if (filter & MutationDiff.CHILDREN){
				for (const op of this.tree.mutations()){
					const node = op.node;
					let log = out.get(node);
					if (!log){
						log = {};
						out.set(node, log);
					}
					const d = log.children = {};
					if (FORIGINAL)
						d.original = op.original ? Object.assign({}, op.original) : null;
					if (FMUTATED)
						d.mutated = op.mutated ? Object.assign({}, op.mutated) : null;
				}
			}
		}
		return out;
	}

	/** Generator which yields groups of adjacent nodes whose DOM position was altered
	 * @param mode bitset, including one of MutationDiff.ORIGINAL or MutationDiff.MUTATED;
	 * 	whether to get nodes' original vs mutated positions
	 * @param {Boolean} include_removed setting this to true will include an additional group
	 * 	for "removed" nodes: nodes that are not present in the original/mutated DOM
	 * @yields {{
	 * 		nodes: [Node],
	 *		parent: Node | null,
	 *		next: Node | null | SiblingPromise | undefined,
	 * 		prev: Node | null | SiblingPromise | undefined
	 * 	}}
	 * 	Group of adjacent nodes, and their position as given by a parentNode (parent),
	 * 	nextSibling (next) and previousSibling (previous). For removed nodes, parent is null
	 * 	and next/prev are not present. If synchronize() has not been called, you may get
	 * 	a SiblingPromise/undefined for next/prev, indicating an unknown position.
	 */
	*diff_grouped_children(mode=MutationDiff.ORIGINAL, include_removed=true){
		if (mode & MutationDiff.ORIGINAL)
			mode = "original";
		else if (mode & MutationDiff.MUTATED)
			mode = "mutated";
		else return;

		const skip = new Set();
		// walk through prev/next and link up any ones that are floating as well
		const link_siblings = (group, op, dir, arrfn) => {
			arrfn = group.nodes[arrfn].bind(group.nodes);
			let bop = op, bop_next, link;
			while (true){
				if (!(link = bop[dir]) || !(bop_next = this.tree.get(link))){
					// inherit the linked ops prev/next
					group[dir] = link;
					break;
				}
				// we'll take over handling the node
				skip.add(link)
				arrfn(link);
				bop = bop_next[mode];
				// broken sibling possible if synchronize hasn't been called
				if (!bop) break;
			}
		};
		const removed = [];
		for (let op of this.tree.mutations()){
			const node = op.node;
			// this node already grouped
			if (skip.has(node)){
				skip.delete(node);
				continue;
			}
			op = op[mode];
			// removed nodes
			if (!op){
				if (include_removed)
					removed.push(node);
				continue;
			}
			const group = {nodes: [node], parent: op.parent};
			link_siblings(group, op, "prev", "unshift");
			link_siblings(group, op, "next", "push");
			yield group;
		}
		if (removed.length)
			yield {nodes: removed, parent: null};
	}

	/** Moves groups of nodes inside the current DOM. When both of a group's siblings are unknown
	 * 	(next/prev are undefined/SiblingPromise), the DOM movement is not performed.
	 * @param groups an iterable giving nodes to be moved and their new position; this should
	 * 	follow the same format as is yielded by `diff_grouped_children()`
	 */
	static patch_grouped_children(groups){
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
		const add = []; // [{group, next: bool}]
		for (const g of groups){
			for (const n of g.nodes)
				n.remove();
			if (g.parent){
				// sibling may be undefined for untracked adds; we'll just skip those nodes
				const next_set = !(g.next === undefined || g.next instanceof SiblingPromise);
				if (!next_set){
					const prev_set = !(g.prev === undefined || g.prev instanceof SiblingPromise);
					if (!prev_set)
						continue;
				}
				add.push({group: g, next: next_set});
			}
		}
		/* If nodes are already inside the correct parent, you could reduce the number of moves. E.g. [BCA],
			assuming all have moved, can be optimized to a single movement of A, rather than setting child
			list to [ABC]. Another might be combining two inserts into one by reinserting any nodes between,
			e.g. [AB],CD,[EF] -> [ABCDEF]. However, I think detecting this kind of optimization will end up
			being more computation than just moving all the children. So we won't optimize node ops any further.
		*/
		// perform node movements
		for (const op of add){
			const g = op.group;
			if (op.next){
				if (g.next)
					g.next.before(...g.nodes);
				else g.parent.append(...g.nodes);
			}
			else{
				if (g.prev)
					g.prev.after(...g.nodes);
				else g.parent.prepend(...g.nodes);
			}
		}
	}

	/** Revert the DOM to its original state. This also has yields the effects of `clear()`.
	 * As noted in `clear()` you may wish to reattach a corresponding MutationObserver.
	 * @param custom_revert `fn(node, key, value)`, which is called for all custom properties
	 * 	that were set (see `custom()`), and should be used to revert that custom value
	 */
	revert(custom_revert=null){
		// TODO: `root` option? might be possible if parents are ordered by rootNode or something
		// revert properties
		for (const [node,props] of this.props.entries())
			props.revert(node, custom_revert);
		this.props.clear();

		// This can be a little more efficient if the methods were inlined, as I used to have it;
		// but for the sake of less code duplication and simpler maintenance, we'll just use these
		MutationDiff.patch_grouped_children(this.diff_grouped_children(MutationDiff.ORIGINAL, true));
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
	 * other mutation processing to keep memory lower.
	 */
	get storage_size(){
		return this.props.size + this.tree.size;
	}

	/** Signals that all mutations have been recorded and the view of the DOM given to
	 * MutationDiff is up-to-date with the current DOM. This would be the case after
	 * MutationObserver.takeRecords has been called, for example. This allows us to release some
	 * cached information about data/attributes/properties. This also can resolves untracked add
	 * mutations, which allows DOM trees disconnected from the root to be reverted correctly.
	 */
	synchronize(){
		for (let [node,props] of this.props.entries()){
			if (!props.synchronize())
				this.props.delete(node);
		}
		this.tree.synchronize();
	}
}

/* Holds a record of mutations for attributes, character data, or custom properties.
 * 
 * With MutationRecord, we only get the oldValue, and need to fetch current value from
 * getAttribute/data get. The lack of point-in-time value means we cannot know if the value is
 * reverted at that point-in-time. We only are aware of a reversion *after the fact* (e.g. a new
 * MutationRecord.oldValue matches what we had cached). So unfortunately this means we'll need to
 * cache oldValue in perpetuity, even when the property is reverted.
 * 
 * You can use synchronize method to remove all reverted properties, but this should only be done if you
 * are sure all MutationRecords have been accounted for already, and the PropertyCache has an
 * accurate view of the current DOM (e.g. when MutationObserver.takeRecords() is called).
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
	/** Removes clean properties from the cache, returning a count of dirty properties left */
	synchronize(){
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
	/** Check if node position has been modified */
	has(node){ return this.floating.has(node); }
	/** Get mutations for a node */
	get(node){ return this.floating.get(node); }
	/** Iterate mutated nodes */
	nodes(){ return this.floating.keys(); }
	/** Iterate mutations */
	mutations(){ return this.floating.values(); }

	/** Add a mutation to the tree
	 * @param {Node} parent parent node where removal/insertion occurred
	 * @param {[Node]} removed an ordered list of nodes that were removed
	 * @param {[Node]} added an ordered list of nodes that were added
	 * @param {Node | null} prev point-in-time previousSibling of the removed/added nodes
	 * @param {Node | null} next point-in-time nextSibling of the removed/added nodes
	 */
	mutation(parent, removed, added, prev, next){
		/* TODO: Technically the removes and adds can happen in any order, and an added node
			can be inserted next to any of the removed nodes. So long as final added ordering
			remains the same, it is fine. The only side case is when a node needs to be removed
			and then readded. I'm wondering if there might be some assumptions you could make
			to maximize the number of fixed nodes. Right now the fixedness check assumes all
			removed nodes are removed first, then after all the adds; so its only propagating
			fixedness from the ends. We'd only be maximizing for the current view though (greedy),
			and my guess is you can craft arbitrary scenarios where subsequent mutations mean
			the end result fixed node count is not maximized.

			Also wondering if it is "proper" to optimize it like that. Treating it like a pure
			batch insert could mean you don't assume a particular insertion order; you can only
			infer things about the ending state.
		*/

		// MutatedNode for prev/next; undefined if it doesn't exist
		let prev_mn, next_mn;

		/* The current DOM state has been revealed between prev and next, so we can resolve
			any SiblingPromise's that are inside that range. We'll remove any inner nodes at
			the same time. Even if there added/removed are empty, we can still resolve promises
			for prev/next.
		*/
		// last seen fixed node and mutated.next SiblingPromise
		let last_fixed, last_promise;
		/** Resolve SiblingPromises between prev and next; stateful, using last_fixed, last_promise,
		 * 	and prev_mn; call this for each node in the prev/next sequence in order
		 * @param {Node | null} node
		 * @param {Boolean} handle_prev node's prev sibling can be resolved
		 * @param {Boolean} handle_next node's next sibling can be resolved
		 * @returns {MutatedNode | undefined} associated MutatedNode for `node` if one exists
		 */
		const handle_promises = (node, handle_prev, handle_next) => {
			let mn;
			if (node && (mn = this.floating.get(node))){
				const m = mn.mutated;
				if (m){
					// case: remove + untracked add + remove;
					// mark any sibling promises that need to be resolved
					if (handle_prev && m.prev instanceof SiblingPromise){
						// joint resolve: promise -> <- promise
						if (last_promise){
							last_promise.resolve(m.prev.origin);
							m.prev.resolve(last_promise.origin);
							last_promise = null;
						}
						// resolve: fixed node <- promise
						else if (last_fixed !== undefined)
							m.prev.resolve(last_fixed);
						// resume: floating node <- first promise;
						// only occurs with the first promise we see, so promise can continue with prev_mn
						else m.prev.resume(prev_mn);
					}
					if (handle_next){
						if (m.next instanceof SiblingPromise)
							last_promise = m.next;
					}
					// resume: last promise -> floating node
					// only occurs with the last promise we see, so mn will necessarily become next_mn
					else if (last_promise)
						last_promise.resume(mn);
				}
			}
			else{
				last_fixed = node;
				// resolve: promise -> fixed node
				if (last_promise){
					last_promise.resolve(node);
					last_promise = null;
				}
			}
			return mn;

			// TODO: need to do revert check on each resolved promise.origin individually
		};

		const fixed = [];
		prev_mn = handle_promises(prev, false, true);
		for (const node of removed){
			let mn = handle_promises(node, true, true);
			// (floating) previously moved node
			if (mn){
				this.mutated.remove(mn);
				// case: add + remove; ops cancel out
				if (!mn.original)
					this.floating.delete(node);
				// case: (remove + add)* + remove
				else mn.mutated = null;
			}
			// (fixed) newly removed
			else{
				// case: add
				mn = new MutatedNode(node);
				mn.original = {parent};
				fixed.push(mn);
				this.floating.set(node, mn);
			}
		}
		next_mn = handle_promises(next, true, false);

		// get original siblings to mark original position for newly removed nodes
		if (fixed.length){
			let fprev = fixed[0];

			/** Set original sibling for first/last node; sibling may be unknown for these, needing
			 * a SiblingPromise; this only occurs when there is a remove + untracked add
			 * @param {"next" | "prev"} forward_dir original sibling to set
			 * @param {"prev" | "next"} backward_dir opposite of forward_dir
			 * @param {MutatedNode | Node | null} hint if we need to search for a sibling via traversal,
			 * 	this specifies the node to start the search for (same arg as SiblingPromise.resume)
			 */
			const original_promise_sibling = (forward_dir, backward_dir, hint) => {
				let sibling = this.original[backward_dir].get(fprev.node);
				if (!sibling){
					sibling = new SiblingPromise(this, fprev, forward_dir);
					// returns true when it resolves immediately; original will be set
					if (sibling.resume(hint))
						return;
				}
				else sibling = sibling.node;
				fprev.original[forward_dir] = sibling;
			};

			original_promise_sibling("prev", "next", prev_mn || prev);
			// adjacent fixed nodes
			for (let fi=1; fi<fixed.length; fi++){
				const fnext = fixed[fi];
				// original sibling(s) were removed from in between fprev-fnext
				const sibling = this.original.prev.get(fprev.node);
				if (sibling){
					fprev.original.next = sibling;
					fnext.original.prev = this.original.next.get(fnext.node);
				}
				// fprev-fnext are eachother's original sibling
				else{
					fprev.original.next = fnext.node;
					fnext.original.prev = fprev.node;
				}
				this.original.add(fprev);
				fprev = fnext;
			}
			original_promise_sibling("next", "prev", next_mn || next);
			this.original.add(fprev);
		}

		// MutatedNode's that may have returned to their original position
		const candidates = [];
		/** Marks new mutated sibling for prev/next
		 * @param {MutatedNode | undefined} mn the mutated node for prev/next
		 * @param {Node | null} sibling the new (mutated) sibling
		 * @param {"prev" | "next"} dir which sibling to set
		 */
		const update_edge = (mn, sibling, dir) => {
			if (!mn) return;
			this.mutated.update(mn, sibling, dir, parent);
			/* Position may be reverted in several cases, such as:
				- original SiblingPromise got resolved
				- incorrect sibling got removed
				- sibling got added and opposite side was fixed
				We can specify more specific conditions for becoming a candidate than what
				we have here, but I don't think it will speed things up by much.
			*/
			if (mn.original?.parent === parent)
				candidates.push(mn);
		};
		update_edge(prev_mn, added[0] || next, "next");
		if (added.length){
			for (let ai=0; ai<added.length; ai++){
				const node = added[ai];
				let mn = this.floating.get(node);
				// case: add
				if (!mn){
					mn = new MutatedNode(node);
					this.floating.set(node, mn);
				}
				// case: remove + add;
				// add + add case not permitted, so no need to update this.mutated;
				// if returned to original parent, candidate for becoming fixed
				else if (mn.original.parent === parent)
					candidates.push(mn);
				// for nodes that are now reverted, this is unnecessary; doing unconditionally for simpler logic
				mn.mutated = {
					parent,
					prev: added[ai-1] || prev,
					next: added[ai+1] || next
				};
				this.mutated.add(mn);
			};
		}
		update_edge(next_mn, added[added.length-1] || prev, "prev");

		/* Check if these nodes have returned to original position (floating to fixed);
			when checking fixedness, we ignore all nodes that would get moved to a different parent.
		*/
		revert_check: if (candidates.length){
			// to become fixed there must be a fixed anchor we attach to on at least one side
			/** Search for a fixed node anchor on one side of `candidates`
			 * @param {MutatedNode | undefined} mn the mutated node to start searching from
			 * @param {Node | null} node if `mn` is not set, this gives a known fixed anchor
			 * @param {"next" | "prev"} dir direction to search for an anchor
			 */
			const fixed_anchor = (mn, node, dir) => {
				if (!mn)
					return {fixed: node};
				while (true){
					// this can become another candidate
					if (mn.original?.parent === parent)
						return {floating: mn};
					// can't traverse further; revert check is deferred until more siblings are known
					let sibling;
					if (!mn.mutated || (sibling = mn.mutated[dir]) === undefined || sibling instanceof SiblingPromise)
						return;
					// fixed node found
					if (sibling === null || !(mn = this.floating.get(sibling)))
						return {fixed: sibling};
					// otherwise, a floating node that originated in another parent; we skip it
				}
			};
			/** Propagate fixedness to `candidates` from one direction
			 * @param {Node | null} fixed a fixed node found from `fixed_anchor()`
			 * @param {Number} idx where to propagating in candidates
			 * @param {Number} end_idx where to end propagation in candidates
			 * @param {"next" | "prev"} forward_dir direction to propagate
			 * @param {"prev" | "next"} backward_dir opposite of `forward_dir`
			 * @param {Boolean} extend if we propagate to all candidates, whether we should traverse
			 * 	the mutated sibling graph to propagate further
			 * @returns {Number | null} null if we propagated to all candidates; otherwise,
			 * 	the idx we stopped at and did not mark as fixed
			 */
			const propagate = (fixed, idx, end_idx, forward_dir, backward_dir, extend) => {
				let mn;
				// mark node as fixed and remove from the graph 
				const mark_fixed = (mn) => {
					fixed = mn.node;
					this.floating.delete(fixed);
					this.original.remove(mn);
					this.mutated.remove(mn);
				}
				// first propagate to candidates (known to be in correct parent)
				const inc = Math.sign(end_idx-idx);
				do {
					mn = candidates[idx];
					// can try from other side instead
					if (mn.original[backward_dir] !== fixed)
						return idx;
					mark_fixed();
				} while ((idx += inc) != end_idx);
				// all candidates reverted; propagate beyond if there may be nodes to revert there
				if (extend){
					outer: while (true){
						// filter out nodes which are not in the correct parent
						do {
							const sibling = mn.mutated[forward_dir];
							// sibling is unknown or fixed
							if (!sibling || sibling instanceof SiblingPromise || !(mn = this.floating.get(sibling)))
								break outer;
						} while (mn.original?.parent !== parent);
						if (mn.original[backward_dir] !== fixed)
							break;
						mark_fixed();
					}
				}
				return null;
			};

			// propagate next
			let next_end_idx = null;
			let anchor = fixed_anchor(next_mn, next, "next");
			if (anchor){
				// fixed anchor found
				if (!anchor.floating){
					next_end_idx = propagate(anchor.fixed, candidates.length-1, -1, "prev", "next", true);
					if (next_end_idx === null)
						break revert_check;
				}
				// floating node can be a candidate when propagating from prev side
				else candidates.push(anchor.floating);
			}
			// propagate prev
			anchor = fixed_anchor(prev_mn, prev, "prev");
			if (anchor && !anchor.floating){
				const extend = next_end_idx === null;
				propagate(anchor.fixed, 0, extend ? candidates.length : next_end_idx+1, "next", "prev", extend);
			}
		}

		try{
			this.#assert_valid_graph();
		} catch(err){
			console.error("invalid graph");
			throw err;
		}
	}

	/** Resolve node positions for untracked node insertions */
	synchronize(){	
		/* Update all mutated siblings to be their correct values. Collect any
			SiblingPromise's to be resolved en-masse afterwards. We update mutated first, so
			we don't have to keep resuming SiblingPromise's
		*/
		// nodes whose promises were resolved, and may be in a reverted position
		const candidates = new Set();
		// promises that need to be resolved
		const next_promises = []; // [SiblingPromise...]
		const prev_promises = new Map(); // {MutatedNode => SiblingPromise}
		const collect_promises = (mn, dir) => {
			const promise = mn.mutated[dir];
			// sibling known
			const is_promise = promise instanceof SiblingPromise;
			if (!is_promise && promise !== undefined)
				return;
			// sibling was unknown
			const prev_dir = dir === "prev";
			const actual = prev_dir ? node.previousSibling : node.nextSibling;
			if (is_promise){
				// candidate for reversion (mutated.parent will be set)
				const mn = promise.mn;
				if (mn.original.parent === mn.mutated.parent)
					candidates.add(mn.node);
				// collect promises to be resolved later
				promise.resume_with = actual;
				if (prev_dir)
					prev_promises.set(mn, promise);
				else next_promises.push(promise);
			}
			this.mutated.update(mn, actual, dir);
		};
		for (const mn of this.mutations()){
			const node = mn.node;
			// an untracked add is assumed to be in a different parent, so we
			// don't mark as candidate for reversion
			if (mn.mutated){
				collect_promises(mn, "prev");
				collect_promises(mn, "next");
			}
			else if (node.parentNode){
				mn.mutated = {
					parent: node.parentNode,
					next: node.nextSibling,
					prev: node.previousSibling
				}
				this.mutated.add(mn);
			}
		}

		// Resolve all next sibling promises;
		// we'll use the prev_promises map to detect promise -> <- promise case here
		for (const next of next_promises){
			let mn, prev;
			let node = next.resume_with;
			while (true){
				// resolve: promise -> fixed
				if (!node || !(mn = this.floating.get(node))){
					next.resolve(node);
					break;
				}
				// resolve: promise -> <- promise
				if (prev = prev_promises.get(mn)){
					next.resolve(prev.origin);
					prev.resolve(next.origin);
					prev_promises.delete(mn); // speedup future searches
					break;
				}
				node = mn.next;
			}
		}

		// Resolve all previous sibling promises;
		// the promise -> <- promise case is not possible, since all have been handled in second pass
		for (const prev of prev_promises.values()){
			let mn;
			let node = prev.resume_with;
			while (node && (mn = this.floating.get(node)))
				node = mn.prev;
			prev.resolve(node);
		}

		/* Check if resolved nodes are in their reverted position. We do this individually for each
			candidate, and all promises have been resolved; so logic is a little different than
			what we do in mutation(). Seems like there would be a more efficient way to do this,
			but I can't think of one at the moment. At the very least you could break it into two
			phases, one to calculate anchors and another to propagate; an anchor result can be
			reused if that anchor is also a candidate.
		*/
		if (candidates.size){
			const fixed_anchor = (mn, parent, dir) => {
				let sibling = mn.mutated[dir];
				while (true){
					if (!sibling || !(mn = this.floating.get(sibling)))
						return {fixed: sibling, dir};
					if (mn.original?.parent === parent)
						return {floating: mn};
					sibling = mn.mutated[dir];
				}
			};
			let fixed;
			const mark_fixed = (mn) => {
				fixed = mn.node;
				this.floating.delete(fixed);
				this.original.remove(mn);
				this.mutated.remove(mn);
				candidates.delete(mn);
			};
			for (const mn of candidates){
				const parent = mn.original.parent;
				const anchors = {
					next: fixed_anchor(mn, parent, "prev"), // propagate fixed anchor to next siblings
					prev: fixed_anchor(mn, parent, "next") // propagate fixed anchor to previous siblings
				};
				// try propagating from prev or next
				for (const forward_dir in anchors){
					const anchor = anchors[forward_dir];
					if (anchor.floating)
						continue;
					const backward_dir = anchor.dir;
					fixed = anchor.fixed;
					// correct sibling, can propagate fixedness to mn and beyond
					if (mn.original[backward_dir] === fixed){
						mark_fixed(mn);
						// start propagation from other anchor
						mn = anchors[backward_dir].floating;
						if (!mn) break;
						propagation: while (mn.original[backward_dir] === fixed){
							mark_fixed(mn);
							// next node; skip if not the right parent
							do {
								const sibling = mn.mutated[forward_dir];
								// stop when we find a fixed node
								if (!sibling || !(mn = this.floating.get(sibling)))
									break propagation;
							} while (mn.original?.parent !== parent);
						}
					}
					// only need to propagate from one side
					break;
				}
				candidates.delete(mn);
			}
		}

		try{
			this.#assert_valid_graph();
		} catch(err){
			console.error("invalid graph after synchronization");
			throw err;
		}
	}

	// for debugging only
	#assert_valid_graph(){
		for (const mn of this.mutations()){
			for (const mode of ["original","mutated"]){
				const g = this[mode];
				const mnm = mn[mode];
				if (!mnm) continue;
				for (const dir of ["prev","next"]){
					const mval = mnm[dir];
					const gval = g[dir].get(mval);
					if (!mval || mval instanceof SiblingPromise){
						if (gval !== undefined)
							throw Error("null/SiblingPromise sibling is being indexed")
					}
					else if (gval !== mn)
						throw Error("indexed sibling doesn't match MutatedNode");
				}

			}
		}
	}
}

/** Container for a node's position change */
class MutatedNode{
	constructor(node){
		this.node = node;
		/* null indicates untracked DOM position (e.g. detached from DOM tree, or in a DOM tree
			whose mutations are not being observed). Otherwise, these are in the form:
				{parent, next, prev}
			giving the old or new location of the node

			When there is an untracked insertion, this.mutated will be unknown. In this case,
			prev/next will be undefined to start. A subsequent mutation may reveal what the mutated
			position currently is. When the mutated prev/next is requested, but still unknown, it is
			set to a SiblingPromise, which is essentially a function to be resumed when the sibling
			becomes known.
		*/
		this.original = null;
		this.mutated = null;
	}
}

/** Used as a placeholder to indicate that a node's current, mutated sibling is unknown. The mutated
 * sibling is only needed when determining a (different) node's original siblings. To facilitate
 * this use case, the promise object is attached to this "origin" node, the one searching for its
 * original sibling. Instead of a new promise for each unknown mutated sibling, the promise object
 * is reused, with the `resume()` method acting like a `then()` callback. When the final original
 * sibling has been found, `resolve()` is called.
 */
class SiblingPromise{
	/**
	 * @param {TreeMutations} tree parent mutations we'll traverse over
	 * @param {MutatedNode} mn the mutated node object we want original siblings for
	 * @param {"prev" | "next"} dir which sibling this promise is for
	 */
	constructor(tree, mn, dir){
		this.tree = tree;
		this.mn = mn;
		this.dir = dir;
		// `resume_with` is used elsewhere to cache a node that we should resume search with
	}
	/** Node that is searching for its original siblings */
	get origin(){ return this.mn.node; }
	/** Resume search for the original sibling
	 * @param {MutatedNode | Node | null} node the node to resume searching at
	 * @returns {Boolean} true if the search found results (promise resolved)
	*/
	resume(node){
		/* Note a "promise -> <- promise" resolve case is not possible while traversing in this
			manner. The reason is that a node's mutated sibling is a SiblingPromise only when the
			A<->B sibling relationship cannot be determined. So if B.prev is unknown, A.next will
			also be unknown, meaning the traversal stops at A.next = SiblingPromise and B.prev =
			SiblingPromise; neither A nor B knows the other, so the promises can't resolve each
			other here. Instaed this gets resolved when a batch `mutation()` comes in, revealing
			A<->B sibling relationship.
		*/
		// resolve: promise -> fixed (null)
		if (node === null){
			this.resolve(null);
			return true;
		}
		// convert Node to MutatedNode
		let smn = node instanceof MutatedNode ? node : this.tree.floating.get(node);
		while (true){
			// resolve: promise -> fixed (node)
			if (!smn){
				this.resolve(node);
				return true;
			}
			// this node had an untracked add, so its sibling is unknown;
			// we'll need to resume later when its sibling is revealed
			if (!smn.mutated)
				smn.mutated = {parent: this.mn.original.parent};
			const sibling = smn.mutated[this.dir];
			if (sibling === undefined){
				smn.mutated[this.dir] = this;
				return false;
			}
			// resolve: promise -> fixed (null)
			if (sibling === null){
				this.resolve(null);
				return true;
			}
			smn = this.tree.floating.get(sibling);
		}
	}
	/** Original sibling found */
	resolve(node){
		this.tree.original.update(this.mn, node, this.dir);
	}
}

/** Indexes MutatedNodes by their prev/next sibling */
class SiblingIndex{
	/** Create a new index
	 * @param {"original" | "mutated"} mode which siblings to index on
	 */
	constructor(mode){
		this.mode = mode;
		this.prev = new Map(); // MutatedNode[mode].prev -> MutatedNode
		this.next = new Map(); // MutatedNode[mode].next -> MutatedNode
	}
	/** Return true if the sibling should be indexed */
	#index(sibling){
		return sibling && !(sibling instanceof SiblingPromise);
	}
	/** Remove a nodes siblings from the index; does not check that
	 * 	the siblings were indexed prior (use `remove_safe()` for that)
	 * @param {MutatedNode} node 
	 */
	remove(node){
		const op = node[this.mode];
		if (!op) return;
		if (this.#index(op.prev))
			this.prev.delete(op.prev);
		if (this.#index(op.next))
			this.next.delete(op.next);
	}
	/** Add a nodes siblings to the index
	 * @param {MutatedNode} node 
	 */
	add(node){
		const op = node[this.mode]
		if (!op) return;
		if (this.#index(op.prev))
			this.prev.set(op.prev, node);
		if (this.#index(op.next))
			this.next.set(op.next, node);
	}
	/** Update a node's sibling to another. It only operates on one side, and will modify `node`
	 * @param {MutatedNode} node the node to update its sibling
	 * @param {Node | null} sibling the new sibling
	 * @param {"next" | "prev"} side which sibling to update
	 * @param {Node} parent parent of `node`, used to initialize MutatedNode[mode] if needed
	 */
	update(node, sibling, side, parent){
		let op = node[this.mode];
		// there was an untracked node insertion
		if (!op)
			op = node[this.mode] = {parent};
		const old = op[side];
		if (old === sibling)
			return;
		op[side] = sibling;
		if (this.#index(old))
			this[side].delete(old);
		if (this.#index(sibling))
			this[side].set(sibling, node);
	}
	/** Remove all siblings from index */
	clear(){
		this.prev.clear();
		this.next.clear();
	}
}