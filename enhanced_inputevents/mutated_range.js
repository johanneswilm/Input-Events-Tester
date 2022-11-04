/** Represents a range bounding mutations. Performing mutations within the bounds will not
 * 	invalidate this range. You can convert this to DOM Range or StaticRange objects, however
 * 	these both could be invalidated by a mutation inside the range. This does not support
 * 	text offsets within CharacterData nodes, as the MutatedRange is tracking the *nodes* that change,
 * 	not the *properties or data* of those nodes.
 * 
 * 	MutatedRange behaves like StaticRange, in that it does not validate the starting anchor is
 * 	before the ending anchor; the range will not move or collapse as the DOM is mutated. However,
 * 	when altering the range, it will usually need to traverse the DOM so the DOM must accurate.
 * 	You can use `setStart()` or `setEnd()` with `collapse=false` to set the anchors directly
 * 	and avoid DOM traversal.
 * 
 * 	The range is defined by a fixed starting and ending anchor node. Mutations come after the
 * 	starting anchor, and before the ending anchor. A node itself bounds nested child nodes, and so
 * 	has an opening and closing boundary; you can specify whether the anchor is in reference
 * 	to this open or closing boundary. Note that you *can* specify the opening/closing boundary
 * 	for CharacterData nodes, even though they cannot have children; since CharacterData is a
 * 	Node, and so has childNodes and related interfaces, it seems better to keep consistent
 * 	Node handling throughout even if some nodes like CharacterData or certain HTMLElements
 * 	happen to disallow children. For these nodes, its recommended to expand the range to include
 * 	that element. The `normalize()` method will perform this expansion for CharacterData nodes,
 * 	but others like certain HTMLElements, you will need to do the expansion yourself. Note
 * 	that when converting to/from a Range/StaticRange object, the range is expanded automatically
 * 	to include CharacterData nodes; this is because Range/StaticRange use a text
 * 	offset for these nodes, which MutatedRange does not support.
 * 
 * 	@member {Node} after Mutations follow this node's opening or closing bounds
 *  @member {Boolean} after_close Whether mutations follow the closing bounds (true, children are not mutated)
 *		or the opening bounds (false, children are mutated) of `after`
 *	@member {Node} before Mutations precede this node's opening or closing bounds
 *	@member {Boolean} before_open Whether mutations precede the opening bounds (true, children are not mutated)
 *		or the closing bounds (false, children are mutated) of `before`
 */
export class MutatedRange{
	////// Trying to adhere to Range interface where applicable ///////

	/** Create a new MutatedRange
	 * @param {Range | StaticRange | MutatedRange | Object | null} spec
	 * Defines the starting/ending anchor for the new range. A number of spec formats are allowed:
	 * - `Range`: Converts from a Range. If the start/end anchor are inside a CharacterData node, these
	 * 	are automatically extended to include the node in the mutated range
	 * - `StaticRange`: Converts from a StaticRange. If the start/end anchor are inside a CharacterData
	 * 	node, these are automatically extended to include the node in the mutated range. The StaticRange
	 * 	interface uses different DOM nodes as reference, so the current DOM may be traversed to build the
	 * 	StaticRange. Keep this in mind, as even though it is a "static" range, it is not static for the
	 * 	purposes of encoding a mutated range.
	 * - `MutatedRange`: Equivalent to `spec.cloneRange()`
	 * - `Object`: An object with the properties: `after`, `after_close`, `before`, and `before_open`;
	 * 	these are passed to `setStart()` and `setEnd()`
	 * - `null`: Creates an empty Range
	 */
	constructor(spec=null){
		if (!spec){
			this.setStart(null, true);
			this.setEnd(null, true);
		}
		else if (spec instanceof Range || spec instanceof StaticRange){
			this.setStartOffset(spec.startContainer, spec.startOffset);
			this.setEndOffset(spec.endContainer, spec.endOffset);
		}
		// MutatedRange and plain object
		else{
			this.setStart(spec.after, spec.after_close);
			this.setEnd(spec.before, spec.before_open);
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

	/** Convert to Range interface. Range's end is set last, so if the resulting range's
	 * 	anchors would be out of order, it would get collapsed to the end anchor. The
	 * 	Range interface requires different DOM nodes as reference, so the current DOM
	 * 	may be traversed to build the Range.
	 * 
	 * Note: If the range start/end anchor is inside a CharacterData node,
	 * 	these are extended to include the node in the output range
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
	/** Convert to StaticRange interface. The StaticRange interface uses
	 * 	different DOM nodes as reference, so the current DOM may be traversed to
	 * 	build the StaticRange.
	 * 
	 * Note: If the range start/end anchor is inside a CharacterData node,
	 * 	these are extended to include the node in the output range
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
	 * @returns {Boolean} true if collapsed, otherwise false; if the start/end anchors
	 * 	are disconnected or out-of-order, it returns false
	 */
	get collapsed(){
		if (this.after_close == this.before_open){
			// must be adjacent
			if (this.after_close)
				return this.after.nextSibling === this.before;
			// must be inside the same empty node
			return this.after === this.before && !this.after.firstChild;
		}
		// end of node
		if (this.after_close)
			return !this.after.nextSibling && this.after.parentNode === this.before;
		// start of node
		return !this.before.previousSibling && this.before.parentNode === this.after;
	}
	/** Collapse the range to one of the boundary points
	 * @param {Boolean} toStart if true collapses to the start anchor (after/after_close);
	 * 	if false (the default), collapses to the end anchor (before/before_open)
	 */
	collapse(toStart=false){
		if (toStart){
			if (this.after_close)
				this.setEndAfter(this.after);
			else{
				const child = this.after.firstChild;
				this.setEnd(child || this.after, Boolean(child));
			}
		}
		else{
			if (this.before_open)
				this.setStartBefore(this.before);
			else{
				const child = this.before.lastChild;
				this.setStart(child || this.before, Boolean(child));
			}
		}
	}
	/** Set starting anchor (after/after_close)
	 * @param {Node} after
	 * @param {Boolean} after_close
	 * @param {Boolean} collapse if true, calls `collapse(true)` after setting the anchor
	 */
	setStart(after, after_close, collapse=false){
		this.after = after;
		this.after_close = after_close;
		if (collapse)
			this.collapse(true);
	}
	/** Set ending anchor (before/before_open)
	 * @param {Boolean} collapse if true, calls `collapse(false)` after setting the anchor
	 */
	setEnd(before, before_open, collapse=false){
		this.before = before;
		this.before_open = before_open;
		if (collapse)
			this.collapse(false);
	}
	/** Set starting anchor (after/after_close) to be before a node
	 * @param {Node} node
	 * @param {Boolean} collapse if true, calls `collapse(true)` after setting the anchor
	 */
	setStartBefore(node, collapse=false){
		const prev = node.previousSibling;
		this.setStart(prev || MutatedRange.#safe_parent(node), Boolean(prev), collapse);
	}
	/** Set ending anchor (before/before_open) to be after a node
	 * @param {Boolean} collapse if true, calls `collapse(false)` after setting the anchor
	 */
	setEndAfter(node, collapse=false){
		const next = node.nextSibling;
		this.setEnd(next || MutatedRange.#safe_parent(node), Boolean(next), collapse);
	}
	/** Set starting anchor using an offset inside a node, in the manner of Range/StaticRange
	 * @param node node where the range should start
	 * @param offset integer giving the offset into node.childNodes, or for CharacterData nodes,
	 * 	the text content; an offset within a CharacterData node will be automatically expanded
	 * 	to include the whole node in the range
	 * @param {Boolean} collapse if true, calls `collapse(true)` after setting the anchor
	 */
	setStartOffset(node, offset, collapse=false){
		if (node instanceof CharacterData)
			this.setStartBefore(node, collapse);
		else{
			const close = Boolean(offset);
			this.setStart(close ? node.childNodes[offset-1] : node, close, collapse);
		}
	}
	/** Set ending anchor using an offset inside a node, in the manner of Range/StaticRange
	 * @param node node where the range should start
	 * @param offset integer giving the offset into node.childNodes, or for CharacterData nodes,
	 * 	the text content; an offset within a CharacterData node will be automatically expanded
	 * 	to include the whole node in the range
	 * @param {Boolean} collapse if true, calls `collapse(false)` after setting the anchor
	 */
	setEndOffset(node, offset, collapse=false){
		if (node instanceof CharacterData)
			this.setEndAfter(node, collapse);
		else{
			const open = offset != node.childNodes.length;
			this.setEnd(open ? node.childNodes[offset] : node, open, collapse);
		}
	}
	/** Make a copy of this range */
	cloneRange(){
		return new MutatedRange(this);
	}
	/** Set range to surround a single node
	 * @param {Node} node the node to surround
	 */
	selectNode(node){
		this.setStartBefore(node);
		this.setEndAfter(node);
	}
	/** Set range to surround the contents of a node;
	 * 	Warning, for CharacterData nodes, you probably want to use selectNode instead,
	 * 	since these nodes cannot have children
	 * @param {Node} node node whose contents to enclose
	 */
	selectNodeContents(node){
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
	/** Check if range matches another;
	 * 	You may wish to call `normalize()` on the ranges prior to comparison
	 */
	isEqual(other){
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