/** Represents a range bounding mutations. Performing mutations within the bounds will not
 * 	invalidate this range. You can convert this to DOM Range or StaticRange objects, however
 * 	these both could be invalidated by a mutation inside the range. This does not support
 * 	ranges within CharacterData nodes, as the MutatedRange is tracking the *nodes* that change,
 * 	not the *properties or data* of those nodes. You can specify a false `after_close` or
 * 	`before_open` for a CharacterData node, but when converted to/from a Range/StaticRange it will
 * 	be extended to include the full node as mutated; this is because while CharacterData are Node's,
 * 	and have a childNodes property, they don't actually let you add children; so in this case, the
 * 	opening/closing bounds aren't relevant.
 * 
 * 	MutatedRange behaves like StaticRange, in that it does not validate the starting anchor is
 * 	before the ending anchor; the range will not move or collapse as the DOM is mutated.
 * 
 * 	The range is defined by four properties:
 * 
 * 	@member {Node} after Mutations follow this node's opening or closing bounds
 *  @member {Boolean} after_close Whether mutations follow the closing bounds (true, children are not mutated)
 *		or the opening bounds (false, children are mutated) of `after`
 *	@member {Node} before Mutations precede this node's opening or closing bounds
 *	@member {Boolean} before_open Whether mutations precede the opening bounds (true, children are not mutated)
 *		or the closing bounds (false, children are mutated) of `before`
 */
export class MutatedRange{
	/** Create a new MutatedRange
	 * @param spec an object containing the properties: after, after_close, before, before_open;
	 * 	if ommitted, an uninitialized MutatedRange is created, and you should set the properties
	 * 	manually before using
	 */
	constructor(spec){
		if (spec){
			this.after = spec.after;
			this.after_close = spec.after_close;
			this.before = spec.before;
			this.before_open = spec.before_open;
		}
	}

	/** Ensure there is a parentNode */
	static #safe_parent(node){
		const p = node.parentNode;
		if (!p)
			throw Error("Node has no parentNode, so there is no fixed reference to define an anchor");
		return p;
	}
	/** Get node's index inside node.parentNode.childNodes */
	static #child_index(node){
		let i = 0;
		while (node = node.previousSibling) i++;
		return i;
	}

	/** Convert a Range to MutatedRange
	 * 
	 * Note: If the range start/end anchor is inside a CharacterData node,
	 * 	these are extended to include the node in the mutated range
	 */
	static fromRange(r){
		const mr = new MutatedRange();
		// start anchor
		const s = r.startContainer;
		if (s instanceof CharacterData){
			mr.after_close = Boolean(s.previousSibling);
			mr.after = mr.after_close ? s.previousSibling : MutatedRange.#safe_parent(s);
		}
		else{
			mr.after_close = Boolean(r.startOffset);
			mr.after = mr.after_close ? s.childNodes[r.startOffset-1] : s;
		}
		// end anchor
		const e = r.endContainer;
		if (e instanceof CharacterData){
			mr.before_open = Boolean(s.nextSibling);
			mr.before = mr.before_open ? s.nextSibling : MutatedRange.#safe_parent(s);
		}
		else{
			mr.before_open = r.endOffset != e.childNodes.length;
			mr.before = mr.before_open ? s.childNodes[r.endOffset] : e;
		}
	}
	/** Convert a StaticRange to MutatedRange
	 * 
	 * Note: In order to make the MutatedRange impervious to mutations, it needs
	 * 	to fetch extra context about the surrounding DOM which is not provided by
	 * 	the StaticRange interface. If the StaticRange is not reflective of the current
	 * 	DOM, then this could lead to an unexpected MutatedRange result. If the DOM
	 * 	is not accurate, and you cannot create a MutatedRange at the time the DOM is
	 * 	an accurate representation of StaticRange, you should manually construct the
	 * 	MutatedRange yourself (`new MutatedRange(spec)`)
	 * 
	 * Note: If the range start/end anchor is inside a CharacterData node,
	 * 	these are extended to include the node in the mutated range
	 */
	static fromStaticRange(r){
		return MutatedRange.fromRange(r);
	}

	/** Convert to Range interface. Range's end is set last, so if the resulting range's
	 * 	anchors would be out of order, it would get collapsed to the end anchor.
	 * 
	 * Note: if `after_close` or `before_open` are false for a CharacterData node,
	 * 	the range is extended to include the node in the mutated range
	 */
	toRange(){
		const r = new Range();
		// start anchor
		if (this.after_close)
			r.setStartAfter(this.after);
		else if (this.after instanceof CharacterData)
			r.setStartBefore(this.after);
		else r.setStart(this.after, 0);
		// end anchor
		if (this.before_open)
			r.setEndBefore(this.before);
		else if (this.before instanceof CharacterData)
			r.setEndAfter(this.before);
		else r.setEnd(this.before, this.before.childNodes.length);
		return r;
	}
	/** Convert to StaticRange interface
	 * 
	 * Note: The StaticRange interface doesn't encode the necessary information to
	 * 	be immutable with mutations within its range. The StaticRange this method
	 * 	generates is based on the current view of the DOM.
	 * 
	 * Note: if `after_close` or `before_open` are false for a CharacterData node,
	 * 	the range is extended to include the node in the mutated range
	 */
	toStaticRange(){
		// Range may have side effects from being unordered, so can't reuse toRange for this
		const spec = {};
		// start anchor
		if (this.after_close || this.after instanceof CharacterData){
			spec.startContainer = MutatedRange.#safe_parent(this.after);
			spec.startOffset = MutatedRange.#child_index(this.after) + this.after_close;
		}
		else{
			spec.startContainer = this.after;
			spec.startOffset = 0;
		}
		// end anchor
		if (this.before_open || this.before instanceof CharacterData){
			spec.endContainer = MutatedRange.#safe_parent(this.before);
			spec.endOffset = MutatedRange.#child_index(this.before) + !this.before_open;
		}
		else{
			spec.endContainer = this.before;
			spec.endOffset = this.before.childNodes.length;
		}
		return new StaticRange(spec);
	}

	////// Trying to adhere to Range interface for methods below where applicable ///////

	/** Expand anchors inside CharacterData nodes to contain the node */
	normalize(){
		if (!this.after_close && this.after instanceof CharacterData)
			this.setStartBefore(this.after);
		if (!this.before_open && this.before instanceof CharacterData)
			this.setEndAfter(this.before);
	}
	/** Check if the range is collapsed in the current DOM. Unlike Range/StaticRange,
	 * 	a collapsed MutatedRange can have DOM elements inserted "inside" the range.
	 * 	The start/end anchors may be in the same position, but they have an implicit
	 * 	"side", so to speak. Collapsed in this context means that there are no DOM nodes
	 * 	in between the start/end.
	 * @returns {Boolean} true if collapsed; if the start/end anchors are disconnected
	 * 	or out-of-order, it returns false
	 */
	get collapsed(){
		if (this.after_close == this.before_open){
			// must be adjacent
			if (this.after_close)
				return this.after.nextSibling === this.before;
			// must be inside the same empty node, except CharacterData
			return this.after === this.before && !(this.after instanceof CharacterData) && !this.after.firstChild;
		}
		if (this.after_close){
			// expanding before would result in collapse
			if (this.before instanceof CharacterData)
				return this.before === this.after;
			// end of node
			return !this.after.nextSibling && this.after.parentNode === this.before;
		}
		// expanding after would result in collapse
		if (this.after instanceof CharacterData)
			return this.before === this.after;
		// start of node
		return !this.before.previousSibling && this.before.parentNode === this.after;
	}
	/** Collapse the range to one of the boundary points in the current DOM
	 * @param {Boolean} toStart if true collapses to the start anchor (after/after_close);
	 * 	if false (the default), collapses to the end anchor (before/before_open)
	 */
	collapse(toStart=false){
		if (toStart){
			if (this.after_close){
				const next = this.after.nextSibling;
				this.before = next || MutatedRange.#safe_parent(this.after);
				this.before_open = Boolean(next);
			}
			else if (this.after instanceof CharacterData){
				this.before = this.after;
				this.before_open = true;
				const prev = this.after.previousSibling;
				this.after = prev || MutatedRange.#safe_parent(this.after);
				this.after_close = Boolean(prev);
			}
			else{
				const child = this.after.firstChild;
				this.before = child || this.after;
				this.before_open = Boolean(child);
			}
		}
		else{
			if (this.before_open){
				const prev = this.before.previousSibling;
				this.after = prev || MutatedRange.#safe_parent(this.before);
				this.after_close = Boolean(prev);
			}
			else if (this.before instanceof CharacterData){
				this.after = this.before;
				this.after_close = true;
				const next = this.before.nextSibling;
				this.before = next || MutatedRange.#safe_parent(this.before);
				this.before_open = Boolean(next);
			}
			else{
				const child = this.before.lastChild;
				this.after = child || this.before;
				this.after_close = Boolean(child);
			}
		}
	}
	/** Equivalent `setStart(...)` then `collapse(true)` */
	setStartCollapsed(after, after_close){
		this.setStart(after, after_close);
		this.collapse(true);
	}
	/** Equivalent `setEnd(...)` then `collapse(true)` */
	setEndCollapsed(before, before_open){
		this.setEnd(before, before_open);
		this.collapse(false);
	}
	/** Set starting anchor (after/after_close) */
	setStart(after, after_close){
		this.after = after;
		this.after_close = after_close;
	}
	/** Set ending anchor (before/before_open) */
	setEnd(before, before_open){
		this.before = before;
		this.before_open = before_open;
	}
	/** Set starting anchor (after/after_close) to be before a node */
	setStartBefore(node){
		const prev = node.previousSibling;
		this.after = prev || MutatedRange.#safe_parent(node);
		this.after_close = Boolean(prev);
	}
	/** Set ending anchor (before/before_open) to be after a node */
	setEndAfter(node){
		const next = node.nextSibling;
		this.before = next || MutatedRange.#safe_parent(node);
		this.before_open = Boolean(next);
	}
	/** Make a copy of this range */
	cloneRange(){
		return new MutatedRange({
			after: this.after,
			after_close: this.after_close,
			before: this.before,
			before_open: this.before_open
		});
	}
	/** Set range to surround a single node in the current DOM */
	selectNode(node){
		this.setStartBefore(node);
		this.setEndAfter(node);
	}
	/** Set range to surround the contents of a node in the current DOM */
	selectNodeContents(node){
		if (node instanceof CharacterData)
			return this.selectNode(node);
		this.after = this.before = node;
		this.before_open = this.after_close = false;
	}
	/** Extend this range to include the bounds of another MutatedRange
	 * @param {MutatedRange} other extend bounds to enclose this range
	 */
	extend(other){
		/* We can usually just check for an anchor node following/preceding; the tricky situation
			where the opening/closing boundary (after_close/before_open) comes into play is when
			the two nodes are nested or equal. For equal nodes, we use the wider (false) boundary.
			For nested nodes, we only need look at the container's boundary. If the boundary
			is wide (false) we use the container, otherwise (true) we use the contained.
		*/
		// extend start
		const ap = this.after.compareDocumentPosition(other.after);
		if (ap & (Node.DOCUMENT_POSITION_DISCONNECTED | Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC))
			throw Error("Start anchors are disconnected, or relative position cannot be determined");
		if (!ap)
			this.after_close = this.after_close && other.after_close;
		else if (
			ap == Node.DOCUMENT_POSITION_PRECEDING ||
			ap & Node.DOCUMENT_POSITION_CONTAINS && !other.after_close ||
			ap & Node.DOCUMENT_POSITION_CONTAINED_BY && this.after_close
		){
			this.after = other.after;
			this.after_close = other.after_close;
		}
		// extend end
		const bp = this.before.compareDocumentPosition(other.before);
		if (bp & (Node.DOCUMENT_POSITION_DISCONNECTED | Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC))
			throw Error("End anchors are disconnected, or relative position cannot be determined");
		if (!bp)
			this.before_open = this.before_open && other.before_open;
		else if (
			bp == Node.DOCUMENT_POSITION_FOLLOWING ||
			bp & Node.DOCUMENT_POSITION_CONTAINS && !other.before_open ||
			bp & Node.DOCUMENT_POSITION_CONTAINED_BY && this.before_open
		){
			this.before = other.before;
			this.before_open = other.before_open;
		}
	}
	/** Check if range matches another
	 * @param {Boolean} normalize if false, it will check for strict equality;
	 * 	if true it calls normalize to expand CharacterData nodes
	 */
	isEqual(other, normalize=true){
		if (normalize){
			this.normalize();
			other.normalize();
		}
		return (
			this.after === other.after &&
			this.after_close == other.after_close &&
			this.before === other.before &&
			this.before_open == other.before_open
		);
	}
}

/** Convert Range to StaticRange or vice-versa
 * @param {Range | StaticRange} r range to convert; if this is not a Range or
 * 	StaticRange, then the value is returned without conversion
 * @returns {StaticRange | Range} Note: if converting to a Range,
 * 	it will be collapsed to the end anchor if the Range would not be valid
 */
export function toggleStaticRange(r){
	if (r instanceof Range){
		return new StaticRange({
			startContainer: r.startContainer,
			startOffset: r.startOffset,
			endContainer: r.endContainer,
			endOffset: r.endOffset
		});
	}
	if (r instanceof StaticRange){
		const range = new Range();
		range.setStart(r.startContainer, r.startOffset);
		range.setEnd(r.endContainer, r.endOffset);
		return range;
	}
	return r;
}