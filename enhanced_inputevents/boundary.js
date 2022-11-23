export const BoundaryFlags = Object.freeze({
	// for Boundary; magnitude matches DOM order
	BEFORE_OPEN: 0b1,
	AFTER_OPEN: 0b10,
	BEFORE_CLOSE: 0b1000,
	AFTER_CLOSE: 0b10000,
	// for BoundaryWalker
	FILTER_ALL: 0b11011,
	FILTER_OPEN: 0b11,
	FILTER_CLOSE: 0b11000,
	FILTER_BEFORE: 0b1001,
	FILTER_AFTER: 0b10010,
	FILTER_INSIDE: 0b1010,
	FILTER_OUTSIDE: 0b10001,
	// for comparing positions relative to a boundary
	POSITION_BEFORE: 0b0,
	POSITION_INSIDE: 0b100,
	POSITION_AFTER: 0b100000
});

export class Boundary{
	/** Create a node boundary; takes up to three arguments:
	 * @param {Boundary | [Node, Number] | [Node, Number, Number]} args one of three formats:
	 * 	1. pass a `Boundary` to copy
	 * 	2. pass a `Node` and one of BEFORE/AFTER_OPEN/CLOSE BoundaryFlags
	 * 	3. in the manner of Range/StaticRange interfaces, pass an anchor `Node`, an offset into that
	 * 		anchor, and one of POSITION_BEFORE/AFTER, indicating which side of the anchor you wish
	 * 		to get the boundary for
	 */
	constructor(...args){
		this.set(...args);
	}
	/** Update boundary values. Same arguments as the constructor */
	set(...args){
		switch (args.length){
			case 1:
				let o = args[0];
				this.node = o.node;
				this.boundary = o.boundary;
				break;
			case 2:
				[this.node, this.boundary] = args;
				break;
			case 3:
				let [node, offset, position] = args;
				const istxt = node instanceof CharacterData;
				if (istxt)
					boundary = position ? BoundaryFlags.AFTER_CLOSE : BoundaryFlags.BEFORE_OPEN;
				else{
					// left/right side; edges switch to AFTER_OPEN/BEFORE_CLOSE
					if (position)
						boundary = offset == node.childNodes.length ? BoundaryFlags.BEFORE_CLOSE : BoundaryFlags.BEFORE_OPEN;
					else boundary = !offset ? BoundaryFlags.AFTER_OPEN : BoundaryFlags.AFTER_CLOSE;
					// if we are referencing a child node
					if (boundary & BoundaryFlags.FILTER_OUTSIDE)
						node = node.childNodes[offset - !position];
				}
				this.node = node;
				this.boundary = boundary;
				// For text, we first clamp outside, then we clamp again to match the desird `position`;
				// no way currently to do an "inclusive" boundary of a CharacterNode using this input syntax
				if (istxt)
					position ? this.next() : this.previous();
				break;
		}
	}
	/** Copy this Boundary object */
	clone(){
		return new Boundary(this);
	}
	/** Convert boundary to an anchor, in the manner of the builtin Range/StaticRange interface.
	 * 	Note that Range switches to encoding text offsets for CharacterData nodes, as children are
	 * 	disallowed for these node types. So for CharacterData nodes, the boundary is interpreted
	 * 	as the nearest "outside" boundary for purposes of anchor conversion.
	 * @returns {{node: Node, offset: Number}} node and offset inside that node
	 */
	toAnchor(){
		let node = this.node, offset = 0;
		// calculate offset by finding node's index in parent's child nodes
		if (this.boundary & BoundaryFlags.FILTER_OUTSIDE || this.node instanceof CharacterData){
			let child = node;
			node = node.parentNode;
			// Range offset indexes the previous side (so open boundaries are exclusive)
			if (this.boundary & BoundaryFlags.FILTER_OPEN)
				child = child.previousSibling;
			while (child !== null){
				child = child.previousSibling
				offset++;
			}
		}
		else if (this.boundary == BoundaryFlags.BEFORE_CLOSE)
			offset = node.childNodes.length;
		return {node, offset};
	}
	/** Compare relative position of two boundaries
	 * @param {Boundary} other boundary to compare with
	 * @returns one of the following:
	 * 	- `null` if the boundaries are from different DOM trees or the relative position can't be determined
	 * 	- `0` if they are equal (see also `isEqual()` method for a faster equality check)
	 * 	- `1` if this boundary is after `other`
	 *  - `-1` if this boundary is before `other`
	 * Note, two boundaries that are adjacent, but have differing nodes/boundaries are not
	 * considered "equal". They have an implicit side to them. Use `isAdjacent()` method to check for
	 * this case instead.
	 */
	compare(other){
		const p = this.node.compareDocumentPosition(other.node);
		if (!p)
			return Math.sign(this.boundary-other.boundary);
		// handle contained/contains before preceding/following, since they can combine
		if (p & Node.DOCUMENT_POSITION_CONTAINED_BY)
			return Math.sign(this.boundary-BoundaryFlags.POSITION_INSIDE);
		if (p & Node.DOCUMENT_POSITION_CONTAINS)
			return Math.sign(BoundaryFlags.POSITION_INSIDE-other.boundary);
		if (p & Node.DOCUMENT_POSITION_PRECEDING)
			return -1;
		if (p & Node.DOCUMENT_POSITION_FOLLOWING)
			return 1;
		// disconnected or implementation specific
		return null;
	}
	/** Check if boundary equals another
	 * @param {Boundary} other boundary to compare with
	 * @returns {Boolean} true if the boundaries are identical
	 */
	isEqual(other){
		return this.node === other.node && this.boundary === other.boundary;
	}
	/** Check if this boundary directly precedes another, in other words, the two Boundary's
	 * 	represent the same DOM insertion point
	 * @param {Boundary} other boundary to compare with
	 * @returns {Boolean} true if `other` is adjacent *following* `this`
	 */
	isAdjacent(other){
		// before_open <-> after_open are not adjacent since one is outside the node and the other inside
		if (this.boundary & BoundaryFlags.FILTER_BEFORE || other.boundary & BoundaryFlags.FILTER_AFTER)
			return false;
		return this.clone().next().isEqual(other);
	}
	/** Traverses to the next boundary point
	 * @returns {Boundary} modified `this`
	 */
	next(){
		switch (this.boundary){
			case BoundaryFlags.AFTER_OPEN:
				const c = this.node.firstChild;
				if (c){
					this.node = c;
					this.boundary = BoundaryFlags.BEFORE_OPEN;
				}
				else this.boundary = BoundaryFlags.BEFORE_CLOSE;
				break;
			case BoundaryFlags.AFTER_CLOSE:
				const s = this.node.nextSibling;
				if (s){
					this.node = s;
					this.boundary = BoundaryFlags.BEFORE_OPEN;
				}
				else{
					this.node = this.node.parentNode;
					this.boundary = BoundaryFlags.BEFORE_CLOSE;
				}
				break;
			// before -> after
			default:
				this.boundary >>= 1;
				break;
		}
		return this;
	}
	/** Traverses to the previous boundary point
	 * @returns {Boundary} modified `this`
	 */
	previous(){
		switch (this.boundary){
			case BoundaryFlags.BEFORE_CLOSE:
				const c = this.node.lastChild;
				if (c){
					this.node = c;
					this.boundary = BoundaryFlags.AFTER_CLOSE;
				}
				else this.boundary = BoundaryFlags.AFTER_OPEN;
				break;
			case BoundaryFlags.BEFORE_OPEN:
				const s = this.node.previousSibling
				if (s){
					this.node = s;
					this.boundary = BoundaryFlags.AFTER_CLOSE;
				}
				else{
					this.node = this.node.parentNode;
					this.boundary = BoundaryFlags.AFTER_OPEN;
				}
				break;
			// after -> before
			default:
				this.boundary <<= 1;
				break;
		}
		return this;
	}
	/** Generator that yields a Boundary for each unique node. Unlike `next()` this method
	 * 	tracks which nodes have been visited, and only emits its first boundary encountered.
	 * 	This method is meant to mimic `TreeWalker`, but instead always doing a preorder traversal
	 * 	so that it iterates parent nodes before child nodes regardless of traversal direction.
	 * 
	 *	For efficiency, `this` is modified just as with `next()`; clone the emitted Boundary if you
	 * 	need a copy.
	 * @yields {Boundary} modified `this`
	 */
	*nextNodes(){
		if (!this.node) return;
		// always BEFORE_OPEN or BEFORE_CLOSE; need to convert start bounds to this
		if (this.boundary & BoundaryFlags.FILTER_AFTER)
			this.next();
		if (!this.node) return;
		yield this;
		let depth = 0;
		while (true){
			// if BEFORE_CLOSE, we've already passed all the children
			if (this.boundary == BoundaryFlags.BEFORE_OPEN && this.node.firstChild){
				this.node = this.node.firstChild;
				depth++;
				yield this;
			}
			else if (this.node.nextSibling){
				this.set(this.node.nextSibling, BoundaryFlags.BEFORE_OPEN);
				yield this;
			}
			else if (this.node.parentNode){
				this.set(this.node.parentNode, BoundaryFlags.BEFORE_CLOSE);
				// while depth non-zero, we've seen this node already
				if (!depth)
					yield this;
				else --depth;
			}
			else return;
		}
	}
	/** Same as `nextNodes()`, but traversing in the previous direction. See docs for `nextNodes()`
	 * @yields {Boundary} modified `this`
	 */
	previousNodes(){
		if (!this.node) return;
		// always AFTER_OPEN or AFTER_CLOSE; need to convert start bounds to this
		if (this.boundary & BoundaryFlags.FILTER_BEFORE)
			this.previous();
		if (!this.node) return;
		yield this;
		let depth = 0;
		while (true){
			// if AFTER_OPEN, we've already passed all the children
			if (this.boundary == BoundaryFlags.AFTER_CLOSE && this.node.lastChild){
				this.node = this.node.lastChild;
				depth++;
				yield this;
			}
			else if (this.node.previousSibling){
				this.set(this.node.previousSibling, BoundaryFlags.AFTER_CLOSE);
				yield this;
			}
			else if (this.node.parentNode){
				this.set(this.node.parentNode, BoundaryFlags.AFTER_OPEN);
				// while depth non-zero, we've seen this node already
				if (!depth)
					yield this;
				else --depth;
			}
			else return;
		}
	}
	/** Insert nodes into the DOM at this boundary position */
	insert(...nodes){
		switch (this.boundary){
			case BoundaryFlags.BEFORE_OPEN:
				this.node.before(...nodes);
				break;
			case BoundaryFlags.AFTER_OPEN:
				this.node.prepend(...nodes);
				break;
			case BoundaryFlags.BEFORE_CLOSE:
				this.node.append(...nodes);
				break;
			case BoundaryFlags.AFTER_CLOSE:
				this.node.after(...nodes);
				break;
		}
	}
}

/** Similar to builtin Range or StaticRange interfaces, but encodes the start/end of the range using
 * 	`Boundary`. The anchors are not specified as an offset into a parent's children, so the range
 * 	is robust to modifications of the DOM. In particular, you can use this to encode bounds for
 * 	mutations, as DOM changes within the range will not corrupt the range.
 * 
 * @member {Boundary} start start of the range
 * @member {Boundary} end end of the range
 */
export class BoundaryRange{
	/** Create a new range
	 * @param {Range | StaticRange | BoundaryRange | [Boundary, Boundary]} args one of these formats:
	 * 	- *empty*: uninitialized range; set start/end manually before using the range
	 * 	- `Range` or `StaticRange`: converts from a Range, defaulting to an "exclusive" range,
	 * 		see `normalize()`
	 * 	- `BoundaryRange`: equivalent to `cloneRange()`
	 * 	- `[Boundary, Boundary`]: set the start/end anchors directly
	 * 
	 *  For more control over itialization, leave args empty and use `setStart()` and `setEnd()` instead.
	 */
	constructor(...args){
		switch (args.length){
			case 1:
				const o = args[0];
				if (o instanceof BoundaryRange){
					this.setStart(o.start);
					this.setEnd(o.end);
				}
				// Range/StaticRange
				else{
					this.setStart(o.startContainer, o.startOffset, BoundaryFlags.POSITION_BEFORE);
					this.setStart(o.endContainer, o.endOffset, BoundaryFlags.POSITION_AFTER);
				}
				break;
			case 2:
				const [s, e] = args;
				this.setStart(s);
				this.setEnd(e);
				break;
		}
	}
	/** Update start anchor; equivalent to `this.start.set()` */
	setStart(...args){ this.start.set(...args); }
	/** Update end anchor; equivalent to `this.start.set()` */
	setEnd(...args){ this.end.set(...args); }
	/** Make a copy of this range object */
	cloneRange(){
		return new BoundaryRange(this);
	}
	/** Convert to Range interface. Range's end is set last, so if the resulting range's
	 * 	anchors would be out of order, it would get collapsed to the end anchor. Boundaries inside
	 *	a CharacterData node are treated as outside for conversion purposes.
	 */
	toRange(){
		const r = new Range();
		// start anchor
		const sn = this.start.node;
		let sb = this.start.boundary;
		if (sn instanceof CharacterData)
			sb = sb == BoundaryFlags.AFTER_OPEN ? BoundaryFlags.BEFORE_OPEN : BoundaryFlags.AFTER_CLOSE;
		switch (sb){
			case BoundaryFlags.BEFORE_OPEN:
				r.setStartBefore(sn);
				break;
			case BoundaryFlags.AFTER_OPEN:
				r.setStart(sn, 0);
				break;
			case BoundaryFlags.BEFORE_CLOSE:
				r.setStart(sn, sn.childNodes.length);
				break;
			case BoundaryFlags.AFTER_CLOSE:
				r.setStartAfter(sn);
				break;
		}
		// end anchor
		const en = this.end.node;
		let eb = this.start.boundary;
		if (en instanceof CharacterData)
			eb = eb == BoundaryFlags.AFTER_OPEN ? BoundaryFlags.BEFORE_OPEN : BoundaryFlags.AFTER_CLOSE;
		switch (eb){
			case BoundaryFlags.BEFORE_OPEN:
				r.setEndBefore(en);
				break;
			case BoundaryFlags.AFTER_OPEN:
				r.setEnd(en, 0);
				break;
			case BoundaryFlags.BEFORE_CLOSE:
				r.setEnd(en, en.childNodes.length);
				break;
			case BoundaryFlags.AFTER_CLOSE:
				r.setEndAfter(en);
				break;
		}
		return r;
	}
	/** Convert to StaticRange interface. Boundaries inside a CharacterData node are treated as
	 * 	outside for conversion purposes.
	 */
	toStaticRange(){
		// Range may have side effects from being unordered, so can't reuse toRange for this
		const sa = this.start.toAnchor();
		const ea = this.end.toAnchor();
		return new StaticRange({
			startContainer: sa.node,
			startOffset: sa.offset,
			endContainer: ea.node,
			endOffset: ea.offset
		});
	}

	/** Check if the range is collapsed in the current DOM. The start/end boundaries must be equal,
	 * 	or start/end must be adjacent to eachother (see `Boundary.isAdjacent()`)
	 * @returns {Boolean} true if collapsed, otherwise false; if the start/end anchors
	 * 	are disconnected or out-of-order, it returns false
	 */
	get collapsed(){
		return this.start.isEqual(this.end) || this.start.isAdjacent(this.end);
	}
	/** Collapse the range to one of the boundary points
	 * @param {Boolean} toStart if true collapses to the start anchor (after/after_close);
	 * 	if false (the default), collapses to the end anchor (before/before_open)
	 */
	collapse(toStart=false){
		if (toStart)
			this.end = this.start.clone();
		else this.start = this.end.clone();
	}
	/** Extend this range to include the bounds of another BoundaryRange
	 * @param {BoundaryRange} other extend bounds to enclose this range
	 */
	extend(other){
		if (this.start.compare(other.start) == 1)
			this.start.set(other.start);
		if (this.end.compare(other.end) == -1)
			this.end.set(other.end);
	}
	/** Set range to surround a single node
	 * @param {Node} node the node to surround
	 */
	selectNode(node){
		this.start.set(node, BoundaryFlags.BEFORE_OPEN);
		this.end.set(node, BoundaryFlags.AFTER_CLOSE);
	}
	/** Set range to surround the contents of a node;
	 * 	Warning, for CharacterData nodes, you probably want to use selectNode instead,
	 * 	since these nodes cannot have children
	 * @param {Node} node node whose contents to enclose
	 */
	selectNodeContents(node){
		this.start.set(node, BoundaryFlags.AFTER_OPEN);
		this.end.set(node, BoundaryFlags.BEFORE_CLOSE);
	}
	/** Check if range exactly matches another
	 * @param {BoundaryRange} other range to compare with
	 */
	isEqual(other){
		return this.start.isEqual(other.start) && this.end.isEqual(other.end);
	}	
	/** Every boundary has one adjacent boundary at the same position. One one side you have the
	 *  AFTER_OPEN/AFTER_CLOSE bounds, and following it will be a BEFORE_OPEN/BEFORE_CLOSE bounds.
	 *  See `Boundary.isAdjacent()`. The start/end anchors can use either boundary and the range is
	 *  equivalent. There are two normalization modes:
	 * 
	 * 	- **exclusive**: start/end anchor boundaries are outside the range; e.g. start boundary is
	 * 		AFTER and end boundary is BEFORE type
	 * 	- **inclusive**: start/end anchor boundaries are inside the range; e.g. start boundary is
	 * 		BEFORE and end boundary is AFTER type
	 * 
	 * 	For example, if you are encoding a range of mutations, you want to normalize the range to
	 * 	be exclusive; that way, the mutated nodes inside the range will not affect the boundaries.
	 * @param {Boolean} exclusive true for exclusive bounds, or false for inclusive
	 */
	normalize(exclusive=true){
		if (exclusive){
			if (this.start.boundary & BoundaryFlags.FILTER_BEFORE)
				this.start.previous();
			if (this.end.boundary & BoundaryFlags.FILTER_AFTER)
				this.end.next();
		}
		else{
			if (this.start.boundary & BoundaryFlags.FILTER_AFTER)
				this.start.next();
			if (this.end.boundary & BoundaryFlags.FILTER_BEFORE)
				this.end.previous();
		}
	}	
}