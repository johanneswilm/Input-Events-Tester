(function () {
  'use strict';

  function _defineProperty(obj, key, value) {
    if (key in obj) {
      Object.defineProperty(obj, key, {
        value: value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    } else {
      obj[key] = value;
    }
    return obj;
  }

  /** Serialize html with some extra features:
   * 	- nodes are tracked and receive a unique id, and for elements, a color
   * 	- a Selection or list of Ranges can be rendered
   * 	- output selectors:
   * 		- span.tag: opening/closing carets and tagname of element; element's color is set as an inline style
   * 		- span.tag_attr: inline attributes for an element
   * 		- span.text: text node; unstyled span's are nested with the text content
   * 		- span[data-sid]: for .tag/.text nodes, this holds unique id for the node
   * 		- span[data-range=start/end/collapsed]: selection/range anchor, may be nested inside span.text
   * 		- span[data-rid]: for selection/range anchor, it indicates the range index
   * 
   * To use, create an anonymous object: new HTMLSerialize(options)
   */
  class HTMLSerialize {
    // divisions in hue, when rotating colors for next element

    // attributes to serialize; {js attribute -> html attribute}

    // singelton tags/eleemnts

    // counter for unique ids and colors; {container -> {id/hue: int}

    /**
     * @param src source element to serialize
     * @param target where to render the serialization
     * @param {Selection | [Range] | [StaticRange]} ranges specifies anchors to be rendered
     */
    constructor(src, target) {
      var ranges = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;
      this.src = src;
      if (!HTMLSerialize.counter.has(src)) HTMLSerialize.counter.set(src, {
        id: 0,
        hue: 0
      });
      this.frag = document.createDocumentFragment();
      this.serialize_recursive(src, ranges ? HTMLSerialize.ranges2anchors(ranges) : null, true);
      target.replaceChildren(this.frag);
    }

    /** Give each node a unqiue id, and each element a hue. Can be used
    	to indicate whether a node was recreated/destroyed
    */
    assign_id(el) {
      if (typeof el.serialization === "undefined") {
        var c = HTMLSerialize.counter.get(this.src);
        el.serialization = Object.assign({}, c);
        c.id++;
        if (el.nodeType == Node.ELEMENT_NODE) c.hue = (c.hue + 360 / (HTMLSerialize.HUE_DIVS + 0.5)) % 360;
      }
    }

    /**
     * @param el element to serialize, as well as children/siblings
     * @param anchors output of ranges2anchors
     * @param skip if true, only render children and any anchors
     */
    serialize_recursive(el, anchors) {
      var skip = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
      var istxt = el.nodeType == Node.TEXT_NODE;
      var hsl_main, hsl_attr, tag; // for rendering matching open/close tag when !istxt
      var a_locs = {};
      if (anchors && anchors.has(el)) {
        a_locs = anchors.get(el);
        anchors.delete(el);
      }

      // render
      if ("before_open" in a_locs) a_locs["before_open"].forEach(this.add_anchor.bind(this));
      if (!skip) {
        this.assign_id(el);
        // text
        if (istxt) {
          var txt = el.textContent;
          var root = this.add_span({
            clazz: "text",
            sid: el.serialization.id
          });
          if ("inside" in a_locs) {
            var prev = 0;
            for (var c of a_locs["inside"]) {
              if (prev != c.pos) this.add_span({
                txt: txt.substring(prev, c.pos),
                root
              });
              this.add_anchor(c, root);
              prev = c.pos;
            }
            txt = txt.substring(prev);
          }
          if (txt) this.add_span({
            txt,
            root
          });
        }
        // start tag
        else {
          hsl_main = HTMLSerialize.hsl(el.serialization.hue);
          hsl_attr = HTMLSerialize.hsl(el.serialization.hue, 75, 50);
          tag = el.tagName.toLowerCase();
          this.add_span({
            txt: "<".concat(tag),
            clazz: "tag",
            style: hsl_main,
            sid: el.serialization.id
          });
          // attributes whitelist
          for (var attr in HTMLSerialize.SHOW_ATTRS) {
            if (el[attr]) this.add_span({
              txt: " ".concat(HTMLSerialize.SHOW_ATTRS[attr], "='").concat(el[attr], "'"),
              clazz: "tag_attr",
              style: hsl_attr
            });
          }
          this.add_span({
            txt: ">",
            clazz: "tag",
            style: hsl_main
          });
        }
      }
      // children
      if (el.firstChild) this.serialize_recursive(el.firstChild, anchors);
      if ("before_close" in a_locs) a_locs["before_close"].forEach(this.add_anchor.bind(this));
      // end tag
      if (!skip && !istxt && !HTMLSerialize.SINGLETON.has(tag)) {
        this.add_span({
          txt: "</".concat(tag),
          clazz: "tag",
          style: hsl_main,
          sid: el.serialization.id
        });
        this.add_span({
          txt: ">",
          clazz: "tag",
          style: hsl_main
        });
      }
      // siblings
      if (!skip && el.nextSibling) this.serialize_recursive(el.nextSibling, anchors);
    }
    add_span() {
      var {
        txt = null,
        clazz = null,
        style = null,
        sid = null,
        root = null
      } = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
      var s = document.createElement("span");
      if (txt) s.textContent = txt;
      if (clazz) s.className = clazz;
      if (style) s.style = style;
      if (sid !== null) s.dataset.sid = sid;
      (root || this.frag).appendChild(s);
      return s;
    }
    add_anchor(anchor) {
      var root = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
      var s = document.createElement("span");
      s.dataset.range = anchor.type;
      s.dataset.rid = anchor.id;
      (root || this.frag).appendChild(s);
    }

    /** CSS color definition from HSL numbers */
    static hsl(h) {
      var s = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 100;
      var l = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 30;
      return "color: hsl(".concat(h, ",").concat(s, "%,").concat(l, "%);");
    }
    /* Converts Selection, [StaticRange], or [Range] to Map in the form:
    	el (element we should render the cursor in reference to) => {
    		loc (before_open/before_close/inside) => [{
    			id: integer index for which range this came from
    			type: anchor type, start/end/collapsed
    			pos: for "inside" loc's only, this indicates the position inside the text node
    		}]
    	}
    	The locs list is sorted by id for before_open/before_close, and by pos for inside.
    */
    static ranges2anchors(ranges) {
      // Selection -> [Range]
      if (ranges instanceof Selection) {
        var convert = [];
        for (var i = 0; i < ranges.rangeCount; i++) {
          convert.push(ranges.getRangeAt(i));
        }
        ranges = convert;
      }
      var anchors = new Map();
      function classify_anchor(id, el, pos, type) {
        // convert to our format
        var loc = "inside";
        if (el.nodeType != Node.TEXT_NODE) {
          if (pos == el.childNodes.length) loc = "before_close";else {
            el = el.childNodes[pos];
            loc = "before_open";
          }
        }
        // init structure
        var locs = anchors.get(el);
        if (!locs) {
          locs = {};
          anchors.set(el, locs);
        }
        var lst = locs[loc];
        if (!lst) {
          lst = [];
          locs[loc] = lst;
        }
        // save value
        var v = {
          id,
          type
        };
        if (loc === "inside") v.pos = pos;
        lst.push(v);
      }
      var id = 0;
      for (var r of ranges) {
        classify_anchor(id, r.startContainer, r.startOffset, r.collapsed ? "collapsed" : "start");
        if (!r.collapsed) classify_anchor(id, r.endContainer, r.endOffset, "end");
        id++;
      }
      for (var locs of anchors.values()) {
        if ("inside" in locs) locs["inside"].sort((a, b) => a.pos - b.pos);
      }
      return anchors;
    }
  }

  /** Renders src HTML to target, optionally marking ranges;
   *	See HTMLSerialize class for details
   */
  _defineProperty(HTMLSerialize, "HUE_DIVS", 7);
  _defineProperty(HTMLSerialize, "SHOW_ATTRS", {
    className: "class"
  });
  _defineProperty(HTMLSerialize, "SINGLETON", new Set(["br", "hr", "wbr", "col", "command", "img"]));
  _defineProperty(HTMLSerialize, "counter", new Map());
  function serialize(src, target) {
    var ranges = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;
    new HTMLSerialize(src, target, ranges);
  }

  // DOM els
  var divs,
    // contenteditable test cases
    output,
    // log output element
    regex,
    // cancel beforeinput inputType regex
    limit,
    // log message limit input
    cancel,
    // cancel beforeinput checkbox
    freeze; // freeze log

  document.addEventListener("DOMContentLoaded", () => {
    divs = document.querySelectorAll("div[contenteditable]");
    output = document.querySelector("output");
    freeze = document.getElementById("freeze");
    cancel = document.getElementById("cancel");
    limit = document.getElementById("limit");
    regex = document.getElementById("regex");

    // Initialize
    document.addEventListener("selectionchange", e => {
      var div = document.activeElement;
      if (div.contentEditable == "true") serialize_current(div);
      log("<b>".concat(e.type, "</b>"));
    });
    divs.forEach(div => {
      // setup serialization
      trim_whitespace(div);
      div.after(document.createElement("pre"));
      serialize_current(div);

      // events
      div.addEventListener("compositionstart", evt_msg);
      div.addEventListener("compositionupdate", evt_msg);
      div.addEventListener("compositionend", evt_msg);
      div.addEventListener("beforeinput", e => {
        var cancel_attempted = false;
        if (cancel.checked && new RegExp(regex.value).test(e.inputType)) {
          cancel_attempted = true;
          e.preventDefault();
        }
        evt_msg(e, cancel_attempted);
      });
      div.addEventListener("input", evt_msg);
    });
  });

  // trim whitespace/textnodes from start/end of element
  function trim_whitespace(el) {
    var f = el.firstChild,
      l = el.lastChild;
    if (f.nodeType == Node.TEXT_NODE) {
      var d = f.data.trimStart();
      if (d) f.data = d;else f.remove();
    }
    if (l.nodeType == Node.TEXT_NODE && l.parentNode) {
      var _d = l.data.trimEnd();
      if (_d) l.data = _d;else l.remove();
    }
  }

  // Create a message for event and log it
  function evt_msg(e, cancel_attempted) {
    var etype = e.type;
    if (e.inputType) etype += "." + e.inputType;
    var root = document.createElement("div");
    root.innerHTML = "<b>".concat(etype, ":</b><ul></ul>");
    var list = root.lastElementChild;
    var attr = (k, v) => {
      var li = document.createElement("li");
      li.textContent = "".concat(k, ": ");
      if ((v === null || v === void 0 ? void 0 : v.nodeType) == Node.ELEMENT_NODE) li.appendChild(v);else li.textContent += JSON.stringify(v);
      list.appendChild(li);
    };
    if (e.dataTransfer instanceof DataTransfer) {
      attr('text/plain', e.dataTransfer.getData("text/plain"));
      attr('text/html', e.dataTransfer.getData("text/html"));
    }
    if (typeof e.data !== "undefined") attr('data', e.data);
    if (typeof e.isComposing === "boolean") attr('isComposing', e.isComposing);
    attr('defaultPrevented', [e.defaultPrevented, cancel_attempted ? "attempted" : "not attempted"]);
    attr('cancelable', e.cancelable);
    attr('timeStamp', e.timeStamp);
    if (e.getTargetRanges) {
      var ranges = e.getTargetRanges();
      if (ranges.length) {
        var pre = document.createElement("pre");
        serialize(e.target, pre, ranges);
        attr('ranges', pre);
      }
    }
    attr('selection', serialize_current(e.target).cloneNode(true));
    log(root);
  }

  // serialize div as it currently is
  function serialize_current(div) {
    var target = div.nextElementSibling;
    serialize(div, target, window.getSelection());
    return target;
  }

  // Keep a log of last N events, in reverse temporal order
  function log(html) {
    if (freeze.checked) return;
    if (typeof html === "string") {
      var cont = document.createElement("div");
      cont.innerHTML = html;
      html = cont;
    }
    output.prepend(html);
    while (output.children.length > limit.valueAsNumber) {
      output.lastElementChild.remove();
    }
  }

})();
