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
		this.props = new PropertyCache();
		/* Floating nodes, e.g. those whose position has changed:
			node => {
				parent: original parent, or null if original parent is untracked (e.g. new node)
				prev: original previous sibling
				next: original next sibling
			}
		*/
		this.floating = new Map();
		/* Indicates a node's original sibling, whenever it differs from the current
			sibling. This graph is used to mark what the original position of a node
			is when it gets moved.
		*/
		this.original_graph = new SiblingGraph();
		/* The current state of siblings at the time of processing. It doesn't store
			all siblings, just the ones affected by a mutation. As MutationRecords are batched,
			the siblings at the time of a record may be behind the actual next/previousSiblings.
			This graph is used to detect when a node returns to its original position.

			TODO: Think about how to trim mutated_graph when a part of the DOM reverts to its
				original position; currently, the mutated_graph could grow to the full size of
				the DOM, even if this.floating is empty. I think you just remove from mutated_graph
				when there are two new fixed siblings adjacent to eachother
		*/
		this.mutated_graph = new SiblingGraph();
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
				/* Coud make a batched add/remove method, which might help reduce some computation 
					with detecting when a node's position has been reverted. Won't do it now, since
					it would greatly increase code complexity.

					Methods like replaceWith or replaceChildren will have both added and removed nodes;
					Additionally, node.before(node,a,b,c) is valid, and will mean node is in both added
					and removed lists; removed needs to be processed first
				*/
				const rem = r.removedNodes;
				const add = r.addedNodes;
				for (let i=0; i<rem.length; i++)
					this.remove(rem[i], r.target, r.previousSibling, rem[i+1] || r.nextSibling);
				for (let i=add.length-1; i>=0; i--)
					this.add(add[i], r.target, r.previousSibling, add[i+1] || r.nextSibling);
				break;
		}
	}
	
	/** Indicate a node has been added at some position
	 * @param {Node} node node that was added
	 * @param {Node} parent parent that node was inserted into
	 * @param {Node | null} prev previous sibling at insertion point
	 * @param {Node | null} next next sibling at insertion point
	 */
	add(node, parent, prev, next){
		this.mutated_graph.node_add(prev, node, next);
		const op = this.floating.get(node);
		// record sibling relationship that we went between
		this.original_graph.maybe_add(prev, next);
		// add node for the first time; delete to revert
		if (!op){
			this.floating.set(node, {parent:null});
			// only used so that maybe_add will see that this node is floating
			this.original_graph.add(node, null);
		}
		else{
			// detect if node position has been reverted
			if (parent === op.parent){
				// whether we know node's position has been reverted
				let fixed = false;
				// if node becomes fixed, we may be able to propagate fixedness to siblings;
				// {node: sibling that can become fixed, it: sibling iterator, dir: direction next/prev}
				let fixed_candidate = null;
				/** Searches for a fixed sibling */
				const find_fixed = (start, dir) => {
					const it = this.#traverse_children(parent, start, dir, true);
					// iterator will always yield *some* fixed reference before ending, due
					// to the way we are building mutated_graph
					while (it.next()){
						const {node, floating} = it.value;
						if (floating){
							// correct relative position, but sibling is not fixed
							if (dir == "prev" && node === op[dir])
								fixed_candidate = {node, it, dir: "next"};
							break;
						}
						// found fixed reference, which may or not be the correct node
						else if (node === op[dir])
							fixed = true;
						break;
					}
				}
				// look for fixed reference in either direction
				find_fixed(prev, "prev");
				if (!fixed)
					find_fixed(next, "next");
				// we haven't traversed in the other direction for a possible propogation candidate
				else fixed_candidate = {node, it: this.#traverse_children(parent, next, "next", true), dir: "prev"};
				if (fixed){
					this.floating.delete(node);
					if (fixed_candidate)
						this.#mark_fixed(fixed_candidate.node, fixed_candidate.it, fixed_candidate.dir, fixed_candidate.sibling !== node);
				}
			}	
			// (optional) prev<->node and node<->next relationship may be restored
			this.original_graph.maybe_remove(prev, node);
			this.original_graph.maybe_remove(node, next);
		}
	}

	/** Indicate a node has been removed from its position
	 * @param {Node} node node that was removed
	 * @param {Node} parent parent that node was removed from
	 * @param {Node | null} prev previous sibling prior to removal
	 * @param {Node | null} next next sibling prior to removal
	 */
	remove(node, parent, prev, next){
		this.mutated_graph.node_remove(prev, node, next);
		const op = this.floating.get(node);
		// removing node for the first time
		if (!op){
			let gprev = this.original_graph.prev(node);
			let gnext = this.original_graph.next(node);
			// record broken siblings, if not broken already
			if (gprev === undefined){
				this.original_graph.add(prev, node);
				gprev = prev;
			}
			if (gnext === undefined){
				this.original_graph.add(node, next);
				gnext = next;
			}
			this.floating.set(node, {parent, prev: gprev, next: gnext});
		}
		// add + remove cancel out
		else if (!op.parent){
			this.floating.delete(node);
			this.original_graph.remove(node, null);
		}
		// otherwise, original position was recorded earlier;
		// removing this node may cause a sibling to be in its reverted position
		if (!op || op.parent === parent){
			const pit = this.#traverse_children(parent, prev, "prev", true);
			const nit = this.#traverse_children(parent, next, "next", true);
			pit.next();
			nit.next();
			const prev_fixed = !pit.value.floating;
			const next_fixed = !nit.value.floating;
			// one is fixed and the other floating; the floating is a candidate to become fixed
			if (prev_fixed != next_fixed){
				if (prev_fixed){
					if (pit.value.node === nit.value.floating.prev)
						this.#mark_fixed(nit.value.node, nit, "prev", true);
				}
				else if (nit.value.node === pit.value.floating.next)
					this.#mark_fixed(pit.value.node, pit, "next", true);
			}
		}
		// (optional) prev<->next relationship may be restored
		this.original_graph.maybe_remove(prev, next);
	}

	/** Traverse proper/original children of a parent. The child may be either fixed
	 * 	or floating. A "fixed" child is one that is in its original position (e.g. not in
	 * 	this.floating). A child may have the correct original siblings, indicating the correct
	 * 	relative position, but a sibling must itself must be fixed to indicate the correct
	 * 	absolute position.
	 * 
	 * `node`, `dir`, and `inclusive` params are forwarded to SiblingGraph.traverse
	 * 
	 * @param {Node} parent the current parent we are traversing, used to check "proper" children
	 * @yields an object {node, floating}, where node is the child and floating is either null
	 * 	(child is fixed) or an object with the original position (child is floating)
	 */
	#traverse_children(parent, node, dir, inclusive){
		// This provides a nicer resumable interface
		const it = this.#traverse_children_gen(parent, node, dir, inclusive);
		let out = {};
		out.next = () => {
			const n = it.next();
			out.value = n.value;
			return !out.done;
		};
		return out;
		
	}
	*#traverse_children_gen(parent, node, dir, inclusive){
		const it = this.mutated_graph.traverse(node, dir, inclusive);
		let i = 0;
		for (const node of it){
			if (++i > 100)
				throw Error("infinite child traversal");
			if (node){
				const op = this.floating.get(node);
				if (op){
					// skip if parent incorrect
					if (op.parent === parent)
						yield {node, floating: op};
					continue;
				}
			}
			// null or fixed node
			yield {node, floating: null};
		}
	}

	/** Mark a node as being fixed, and then propagate fixedness to any siblings if possible
	 * @param {Node} node the node that has become fixed
	 * @param it an iterator given by resumable(traverse_proper_children)
	 * @param {String} dir "next" or "prev" indicating the *opposite* direction the iterator is traversing
	 * @param {Boolean} inclusive whether `node` should be marked
	 */
	#mark_fixed(node, it, dir, inclusive){
		if (inclusive)
			this.floating.delete(node);
		while (it.next()){
			const v = it.value;
			// end of container, fixed node, or incorrect sibling
			// (Note, sibling check is opposite of direction)
			if (!v.floating || v.floating[dir] !== node)
				break;
			node = v.node;
			this.floating.delete(node);
		}
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
			for (const [node,op] of this.floating.entries()){
				// we can just check parent here; parent == root is okay
				if (op.parent && root.contains(op.parent) || node.parentNode && root.contains(node.parentNode))
					return true;
			}
			return false;
		}
		if (this.floating.size)
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
		for (const [node,op] of this.floating.entries()){
			// current position
			if (node.parentNode && !this.props.get(node)?.dirty && include(node)){
				sr.selectNode(node);
				union();
			}
			/* Original position: Only care about fixed nodes when marking the original bounds.
				If prev/next bounds have been moved, then the bounds get extended to *their* siblings,
				so we delegate the bound extension to those siblings instead. Eventually, a fixed
				node will be found that is a candidate.
			*/
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
		this.original_graph.clear();
		this.mutated_graph.clear();
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
		*/
		for (const [node,op] of this.floating.entries()){
			// remove nodes to handle ancestor-child ordering
			node.remove();
			if (!op.parent){
				this.floating.delete(node);
				continue;
			}
			const linked = [node];
			op.linked = linked;
			// walk through prev/next and link up any ones that are floating as well
			const link_siblings = (dir, arrfn) => {
				arrfn = linked[arrfn].bind(linked);
				let bop = op, bop_next, link;
				while (true){
					if (!(link = bop[dir]) || !(bop_next = this.floating.get(link))){
						// inherit the linked ops prev/next
						op[dir] = link;
						break;
					}
					// we'll take over handling the node
					this.floating.delete(link);
					arrfn(link);
					// remove nodes to handle ancestor-child ordering
					link.remove();
					bop = bop_next;
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
		for (const op of this.floating.values()){
			if (op.next)
				op.next.before(...op.linked);
			else op.parent.append(...op.linked);
		}
		this.floating.clear();
	}

	/** Clear the internal log of mutations, effectively "committing" the current DOM.
	 * You may also wish to reattach a corresponding MutationObserver, as it can track
	 * DOM nodes outside root. After clearing/reverting, these disconnected trees do
	 * not matter anymore.
	 */
	clear(){
		this.mutated_graph.clear();
		this.original_graph.clear();
		this.props.clear();
		this.floating.clear();
	}

	/** For memory optimization: Returns a value indicating the size of internal storage for
	 * tracking the mutations. You could use this to trigger periodic reversion/clearing or
	 * other mutation processing to keep memory low.
	 */
	get storage_size(){
		return this.props.size + this.floating.size + this.original_graph.size + this.mutated_graph.size;
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

/** Bipartite sibling graphs. Meant as a lightweight container with
 * 	very little constraints or verification
 */
class SiblingGraph{
	constructor(){
		// node -> nextSibling; doesn't encode node = null
		this._next = new Map();
		// node -> previousSibling; doesn't encode node = null
		this._prev = new Map();
	}
	/** Size of the graph */
	get size(){ return Math.max(this._next.size, this._prev.size); }
	/** Remove all edges from the graph */
	clear(){
		this._next.clear();
		this._prev.clear();
	}
	/** Get next sibling */
	next(node){ return this._next.get(node); }
	/** Get previous sibling */
	prev(node){ return this._prev.get(node); }
	/** Add an A-B sibling relationship
	 * 	Warning: overwrites any existing relationship
	 */
	add(a,b){
		if (a)
			this._next.set(a,b);
		if (b)
			this._prev.set(b,a);
	}
	/** Add an A-B relationship if neither node has a relationship already;
	 * 	Warning: this assumes if A doesn't have a "next" relationship, then B
	 * 	won't have a "prev" relationship
	 */
	maybe_add(a,b){
		if (a ? !this._next.has(a) : b && !this._prev.has(b))
			this.add(a,b);
	}
	/** Record sibling changes when B is inserted between A-C */
	node_add(a, b, c){
		this._next.set(b,c);
		this._prev.set(b,a);
		if (a)
			this._next.set(a,b);
		if (c)
			this._prev.set(c,b);
	}
	/** Remove an A-B sibling relationship;
	 * 	Warning: this assumes that relationship exists; use `maybe_remove` if you want
	 *	to check before removing
	 */
	remove(a,b){
		if (a)
			this._next.delete(a);
		if (b)
			this._prev.delete(b);
	}
	/** Remove an A-B sibling relationship if that relationship currently is set */
	maybe_remove(a,b){
		if (a ? this._next.get(a) === b : b && this._prev.get(b) === a)
			this.remove(a,b);
	}
	/** Record sibling changes when B is removed from between A-C */
	node_remove(a, b, c){
		this._next.delete(b);
		this._prev.delete(b);
		if (a)
			this._next.set(a,c);
		if (c)
			this._prev.set(c,a);
	}
	/** Traverse the sibling graph
	 * @param {Node} node node to start with
	 * @param {String} dir direction, either "next" or "prev"
	 * @param {Boolean} inclusive whether to include `node` in traversal
	 * @yields `node` and then any siblings (including a possible "null" sibling)
	 */
	*traverse(node, dir, inclusive=false){
		const advance = this[dir].bind(this);
		if (inclusive)
			yield node;
		while ((node = advance(node)) !== undefined)
			yield node;
	}
}