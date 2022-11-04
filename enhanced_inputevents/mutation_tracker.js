import { MutatedRange } from "./mutated_range.js";

/** Cleaner interface, in my opinion, for iterating in a resumable manner.
 * @param it an iterator
 * @returns a resumable iterator object; use like so:
 * ```
 *		while(it.next()){ it.value };
 * ```
 */
function resumable(it){
	let out = {};
	out.next = () => {
		const n = it.next();
		out.value = n.value;
		return !out.done;
	};
	return out;
}

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
		/* Node property changes:
			node => {
				native: Map(attr_name => original attribute value),
					null attribute name is used for character data
				custom: Map(custom_key => original custom value)
				size: native.size + custom.size
			}
		*/
		this.props = new Map();
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
				/* We could make add/remove methods take a batch of nodes to match MutationRecord
					interface. A lot of add/remove logic is individual though, and batching only
					assists in a couple places... and there, it would greatly increase complexity
					of the code. So I don't think its worth doing a batched version
				*/
				// Note: methods like replaceWith or replaceChildren will have both added and removed nodes
				let removed_ref = r.previousSibling;
				if (r.addedNodes.length){
					let prev = r.previousSibling;
					for (const cur of r.addedNodes){
						this.add(cur, r.target, prev, r.nextSibling);
						prev = cur;
					}
					removed_ref = prev;
				}
				// I think its better to do remove after add, since these removed nodes may be fixed,
				// and so can help when detecting if an added node returns to its original position
				if (r.removedNodes.length){
					let cur = r.removedNodes[0];
					for (let i=1; i<r.removedNodes.length-1; i++){
						const next = r.removedNodes[i];
						this.remove(cur, r.target, removed_ref, next);
						cur = next;
					}
					this.remove(cur, r.target, removed_ref, r.nextSibling);
				}
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
		if (!op)
			this.floating.set(node, {parent:null});
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
					const it = resumable(this.#traverse_proper_children(parent, start, dir, true));
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
				else fixed_candidate = {node, it: resumable(this.#traverse_proper_children(parent, next, "next", true)), dir: "prev"};
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
		else if (!op.parent)
			this.floating.delete(node);
		// otherwise, original position was recorded earlier;
		// removing this node may cause a sibling to be in its reverted position
		if (!op || op.parent === parent){
			const pit = resumable(this.#traverse_proper_children(parent, prev, "prev", true));
			const nit = resumable(this.#traverse_proper_children(parent, next, "next", true));
			pit.next();
			nit.next();
			const prev_fixed = !pit.value.floating;
			const next_fixed = !nit.value.floating;
			if (prev_fixed != next_fixed){
				let it, dir;
				if (prev_fixed){
					it = nit;
					dir = "prev";
				}
				else{
					it = pit;
					dir = "next";
				}
				this.#mark_fixed(it.value.node, it, dir, true);
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
	*#traverse_proper_children(parent, node, dir, inclusive){
		const it = this.mutated_graph.traverse(node, dir, inclusive);
		for (const node of it){
			if (node){
				const op = this.floating.get(node);
				if (op){
					// wrong parent
					if (op.parent !== parent)
						continue;
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
		// first time seeing this node
		if (!props){
			if (old_value === value)
				return;
			props = {
				native: new Map(),
				custom: new Map(),
				size: 1 // native.size + custom.size
			};
			this.props.set(node, props);
			props[mode].set(key, old_value);
			return;
		}
		const map = props[mode];
		// first time seeing this key;
		// using has(), in case the value happens to be undefined
		if (!map.has(key)){
			if (old_value === value)
				return;
			map.set(key, old_value);
			props.size++;
		}
		// prop reverted
		else if (map.get(key) === value){
			map.delete(key);
			// all props reverted
			if (!--props.size)
				this.props.delete(node);
		}
	}

	/** Indicate HTML attribute changed
	 * @param {Node} node node whose attribute changed
	 * @param {String} key namespace qualified attribute name, e.g. "namespace:name"
	 * @param old_value previous value; on the first call with this key, this should
	 * 	represent the original value, and is used to detect whether the attribute
	 * 	change has been reverted; on subsequent calls before reversion, it is ignored
	 */
	attribute(node, key, old_value){
		return this.#prop(node, "native", key, node.getAttribute(key), old_value);
	}
	/** Indicate data change for a CharacterData node
	 * @param {Node} node node whose data (text content) changed
	 * @param old_value previous text content; on the first call with this key, this should
	 * 	represent the original value, and is used to detect whether the data
	 * 	change has been reverted; on subsequent calls before reversion, it is ignored
	 */
	data(node, old_value){
		// we use null as the key for data
		return this.#prop(node, "native", null, node.data, old_value);
	}
	/** Indicate some custom property for the node has changed. Custom properties are not
	 * 	automatically reverted; you must provide a callback to revert them yourself
	 * @param {Node} node node whose property changed
	 * @param key any Map capable object
	 * @param value current value
	 * @param old_value previous value; on the first call with this key, this should
	 * 	represent the original value, and is used to detect whether the property
	 * 	change has been reverted; on subsequent calls before reversion, it is ignored
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
			for (const node of this.props.keys())
				if (root.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_CONTAINED_BY)
					return true;
			for (const [node,op] of this.floating.entries()){
				// rather than check prev/next siblings, we just check parent instead; parent == root is okay
				if (op.parent && root.contains(op.parent) || node.parentNode && root.contains(node.parentNode))
					return true;
			}
			return false;
		}
		return Boolean(this.props.size || this.floating.size);
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
		for (const node of this.props.keys()){
			if (include(node)){
				sr.selectNode(node);
				union();
			}
		}
		for (const [node,op] of this.floating.entries()){
			// current position
			if (node.parentNode && !this.props.has(node) && include(node)){
				sr.selectNode(node);
				union();
			}
			/* previous position; A little tricky, since its siblings may have moved around,
				in which case the range will extend to *their* siblings. Since they may have
				moved, we can't just define a range from prev to next, as that range may not
				be valid. Better to just treat the prev/next endpoints by themselves (as a
				collapsed range)
			*/
			const p = op.parent;
			if (p){
				const prev = op.prev, next = op.next;
				const include_parent = !root || !(prev && next) && root.contains(p);
				// after prev
				if (prev){
					if (prev.parentNode && include(prev)){
						sr.setStart(prev, true, true);
						union();
					}
				}
				// start of parent
				else if (include_parent){
					sr.setStart(p, false, true);
					union();
				}
				// before next
				if (next){
					if (next.parentNode && include(next)){
						sr.setEnd(next, true, true);
						union();
					}
				}
				// end of parent
				else if (include_parent){
					// if no children, may have already done this anchor in !prev branch
					if (p.firstChild || prev){
						sr.setEnd(p, false, true);
						union();
					}
				}
			}
		}
		return fr;
	}

	/** Revert the DOM to its original state. This also has yields the effects of `clear()`
	 * @param custom_revert fn(node, key, value), which is called for all custom properties
	 * 	that were set (see `property()`), and should be used to revert that custom value
	 */
	revert(custom_revert=null){
		this.original_graph.clear();
		this.mutated_graph.clear();
		// revert properties
		for (const [node,props] of this.props.entries()){
			for (const [attr,val] of props.native){
				if (attr === null)
					node.data = val;
				else node.setAttribute(attr, val);
			}
			if (custom_revert){
				for (const [key,val] of props.custom)
					custom_revert(node, key, val);
			}
		}
		this.props.clear();
		// revert DOM positions
		/* First we categorize nodes by parent, linking adjacent nodes together. Linking adjacents
			is essential; it defines the order of movements to get a valid result, which also lets
			us batch the movements.

			parents: Map(parent => {
				// This is just indexing by each object's next and prev values
				"next"/"prev": Map(
					next/prev excluding null prev => {
						nodes: doubly linked list of nodes to be inserted
						next: node to insert before
						prev: node to insert after
					}
				)
			})
		*/
		const parents = new Map();
		for (const [node,op] of this.floating.entries()){
			// node removals
			if (!op.parent){
				node.remove();
				continue;
			}
			// node reposition
			let pnodes = parents.get(op.parent);
			if (!pnodes){
				pnodes = {next: new Map(), prev: new Map()};
				parents.set(op.parent, pnodes);
			}
			/* check if we can prepend/append this node to an existing list;
				if there is just a single node in-between two inserts, let's absorb
				it into the inserts; e.g. [AB],C,[DE], becomes a single insert [ABCDE]; you
				could absorb longer strings of nodes, but that would take extra work to detect
			*/
			let pst_absorb = false,
				pre_absorb = false,
				// [pst_op, node]
				pst_op = pnodes.next.get(node),
				// [node, pre_op]
				pre_op = pnodes.prev.get(node);
			if (!pst_op && op.prev){
				// [pst_op, op.prev, node]
				pst_op = pnodes.next.get(op.prev);
				if (pst_op){
					pst_absorb = true;
					// could be a floating node we haven't seen yet
					this.floating.delete(op.prev);
				}
			}
			if (!pre_op && op.next){
				// [node, op.next, pre_op]
				pre_op = pnodes.prev.get(op.next);
				if (pre_op){
					pre_absorb = true;
					// could be a floating node we haven't seen yet
					this.floating.delete(op.next);
				}
			}
			// add to existing list
			if (pst_op){
				pnodes.next.delete(pst_op.next);
				if (pst_absorb)
					pst_op.nodes.push(op.prev);
				pst_op.nodes.push(node);
				// this node links up two lists;
				// [pst_op, (op.prev), node, (op.next), pre_op]
				if (pre_op){
					pnodes.prev.delete(pre_op.prev);
					if (pre_absorb)
						pst_op.nodes.push(op.next);
					pst_op.nodes.push(...pre_op.nodes)
					pst_op.next = pre_op.next;
				}
				else pst_op.next = op.next;
				pnodes.next.set(pst_op.next, pst_op);
			}
			else if (pre_op){
				pnodes.prev.delete(pre_op.prev);
				if (pre_absorb)
					pre_op.nodes.unshift(op.next);
				pre_op.nodes.unshift(node);
				pre_op.prev = op.prev;
				if (pre_op.prev)
					pnodes.prev.set(pre_op.prev, pre_op);
			}
			// can't link to any list currently
			else{
				const new_op = {nodes: [node], prev: op.prev, next: op.next};
				pnodes.next.set(new_op.next, new_op);
				if (new_op.prev)
					pnodes.prev.set(new_op.prev, new_op);
			}
		}
		this.floating.clear();
		/* If nodes are already inside the correct parent, you could reduce the number
			of moves. E.g. [BCA], assuming all have moved, can be optimized to a single
			movement of A, rather than setting child list to [ABC]. However, I think
			detecting this kind of optimization will end up being more computation than
			just moving all the children. So we won't optimize node ops any further
		*/
		// perform node movements
		for (const [parent,graph] of parents.entries()){
			for (const op of graph.next.values()){
				if (op.next)
					op.next.before(...op.nodes);					
				else parent.append(...op.nodes);
			}
		}
	}

	/** Clear the internal log of mutations, effectively "committing" the current DOM */
	clear(){
		this.props.clear();
		this.floating.clear();
		this.mutated_graph.clear();
		this.original_graph.clear();
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