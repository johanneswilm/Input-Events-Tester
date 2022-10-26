The following are several proposals to minimally modify the [Input Events specification](https://www.w3.org/TR/input-events-2/), so that composition events can be handled cleanly. Rather than a complete overhaul or entirely new API, these can hopefully be implemented quickly as they are mainly just exposing existing functionality that the browser uses internally for composition (except #3, which could be more extensive).

# 1) `compositionborder`

*[High Priority]*

Take the following examples:
```html
Math:
	x<sup>3</sup>(y<sub>i</sub>)
Programming:
	<span class="v">this</span><span class="o">-</span><span class="n">125</span>
English:
	the suffix -esque, as in pictur<u>esque</u>
```
**Motivation:** There are two problems:

1. When a single word is recomposed, as in Android IME, browsers may delete, add, or move elements and textnodes. If you try to edit a contiguous, styled string of text, the browser may absorb the styles into a single element unpredictably. Firefox always does this, while Chrome in some cases will be intelligent about which style to apply. For specific browser behavior, see the middle of [my comment here](https://github.com/w3c/input-events/issues/134#issuecomment-1289626740). Composition events cannot be controlled, so any styling will be ruined and we must wait for the composition to finish before repairing it; if the user is entering a long phrase, this will be a big jank in style and the user can get confused or assume the app is buggy.

2. If a cursor is bordering two text nodes, browsers place new characters in the left one, even if the cursor was manually placed in the right text node via JavaScript. E.g. Firefox will respect the cursor if the element's `textContent` is non-empty but Chrome always picks the left. If a user requests to start a new style (bold, italic, etc), we could make sure the characters entered next were placed in the correct element, or a new empty element. However, with composition events, we can't control how the browser inserts text, so the styles the user requested won't be respected until the DOM gets repaired.

To test these yourself, see https://azmisov.github.io/Input-Events-Tester/. The effect of these problems is that there is an unavoidable style jank during compositions. Repairing the DOM is complex, so for simpler text editors that don't do it, the user's styles are permanently modified. The only way for a user to predictably edit text is to reapply styles, which can be very annoying.

**Proposal:** Introduce a `compositionborder=true` HTML attribute for children inside a `contenteditable=true` container. This would signal to the browser that the element is stylistically or semantically disconnected from adjacent text.
- IME composition would be restricted to only occur within the element. In particular, if the element only contains textnodes, the browser should guarantee that the composition will only add/delete/edit textnodes inside the element (and not introduce HTML elements). Internally, a browser could restrict the IME selection clause to stop at the element border, or it can reset the IME state using that element as the root.
- It follows that the output of `getTargetRanges` will always be contained inside the element. Composing outside the element should trigger a `compositionend` prior.
- If the cursor is inside the (possibly empty) element, inserted composition characters should be placed inside that element. In other words, the cursor should not be moved to an adjacent element, crossing the `compositionborder`. This is only for insertion; deletion can still cross the border, e.g. when pressing backspace at the start of the node, or delete at the end.

  - Alternatively, browsers could respect the cursor position for inserted text univerally (even empty elements), not just for `compositionborder` elements. The problem only occurs with composition events though, since other events we can cancel and retarget ourselves; so it is only *necessary* for `compositionborder`.

The idea here is not to cancel composition, or control the characters entered, but simply to "sandbox" where the composition occurs. This allows developers to encapsulate the range of modifications, so that there is no undesirable style jank.

**Emulating:** There is no way to emulate this behavior reliably via JavaScript, so this is the most critical of the proposals. In Firefox, changing the elements to be `<article>` or similar seems to accomplish what `compositionborder` would do, though it does not respect the cursor for an empty element. For all browsers, you can mimic the effect of `compositionborder` by adding a zero-width space to the start and end of an element. This only works for single word IME compositions, and introduces a number of undesirable side-effects that need to be repaired in JavaScript.

# 2) `requestCompositionEnd()`

*[Medium Priority]*

**Motivation:** During composition, we may detect characters that we know are stylistically or semantically disconnected. In English, a hyphen is common, such as "bluish-purple". As IME's are designed around human language, this would be interpreted as a single composition string. For a programming language, we have better knowledge than the IME that `-` is an operator and should be interpreted instead like a space or period.

**Proposal:** Introduce a `requestCompositionEnd()` method to the `insertCompositionText` event of `beforeinput` and `input`. Calling the method will proceed with the `insertCompositionText` like normal, but then the browser will forcibly commit the composition, going through the traditional `deleteCompositionText`, `insertFromComposition`, and `compositionend` flow.

The idea is the developer can parse the replacement text (in `beforeinput`) or the current text (in `input`) and notify the browser when it knows the composition string should be finished. This allows an editor like CodeMirror to support mobile without a jank in style. If you try to enter `this-125` on CodeMirror's [homepage JavaScript demo](https://github.com/w3c/input-events/issues/codemirror.net) using Android, you'll notice a jank in style before syntax highlighting takes effect.

**Emulating:** Requesting composition end can currently be emulated by blurring and then focusing the editor element. Since it can be emulated, it is less important, but introducing the API  would guarantee the behavior.

```javascript
editor.blur();
editor.focus();
```
See [here](https://stackoverflow.com/questions/63204395/how-can-i-reliably-cancel-a-compositionstart-event), or its [usage in CodeMirror](https://github.com/codemirror/codemirror5/blob/e1fe2100d0fdc7c34d47993f6514bdd2213c0015/src/input/ContentEditableInput.js#L350)

# 3) Revert DOM when composition ends

*[Low Priority]*

**Motivation:** All `beforeinput` events except composition can be canceled in modern browsers. This lets you control the DOM inside an editor in a predictable way. For compositions we cannot control the DOM, so instead we have the `deleteCompositionText` and cancelable `insertFromComposition` events to let you undo the composition's modifications. The Input Events specification does not go into detail for what `deleteCompositionText` should do, and browser support is lacking.

With the current spec, `deleteCompositionText` can be interpreted as simply removing the composition plaintext. However, browsers will add, remove, and modify DOM elements during composition, so even if the plaintext were removed, the DOM is now in an unknown state. Unlike all other `inputType`s, developers will need to use `MutationObserver` or similar to revert the DOM themselves.

**Proposal**: Redefine/clarify the behavior of `deleteCompositionText`: the event reverts the DOM to its original state at the start of composition. This would allow `insertFromComposition` to be handled just like every other event, where the DOM is in a predictable state, and canceling keeps the DOM unchanged. The `deleteCompositionText` should not just remove the composition string, but also restore the original string and all DOM elements.

This also means the data and target range for `insertFromComposition` would need to be in terms of the original, unmodified DOM. Another gap in the spec is how multiple composition ranges should be handled for `insertFromComposition`. Ideally in this case, a list of `[{range, data}]` pairs would be provided instead of the disconnected `getTargetRanges` and `data`.

<details><summary>Example algorithm for generating `insertFromComposition` data pairs</summary>
<p>
The composition target is the nearest ancestor with `compositionborder=true`, or the furthest ancestor with `contenteditable=true`. To calculate the `{range,data}` list, the browser can track an ordered list of ranges for the *plaintext* of the composition target; call this the `edit_list`. Each range has the attributes:

- `edited`: boolean indicating this range has been edited
- `length`: how many characters in the current text this range spans
- `original_length`: number of characters from the original unedited plaintext; if `!edited`, then `original_length == length`
- `data`: (optional) if `edited=true`, one could cache the current `textContent` in this range

Initially, there is just one range:
 ```javascript
edit_list = [{
	edited: false,
	length: target.textContent.length
	original_length: target.textContent.length
}]
```
 For every new composition event, we convert its `StaticRange` to plaintext offsets relative to the target. There will be 1+ intersecting ranges in the `edit_list`. Intersections can be found efficiently if `edit_list` is stored in a "Binary Indexed Tree" or similar data structure (an indexed tree could also be used to convert StaticRange to plaintext offsets). To add the new range to the list:

 - If the first/last intersecting range are partial and `edited=false`, split them at the intersection point.
 - Let `new_length` and `new_original_length` be the sum of all intersecting range's `length` and `original_length`
 - Remove intersecting ranges
 - Insert a new range at the removal point: `{edited:true, length: new_length, original_length: new_original_length}`

When `insertFromComposition` is dispatched, convert `edit_list` to a `{range,data}` list in reference to the original reverted DOM:

- The original plaintext start/end is given by cumulative sum of `original_length`. Iterating through the original textnodes, or by using another binary indexed tree structure, one can create `StaticRange`s with the appropriate text nodes.
- The same procedure can be used with `length` to extract `data`, this time on the modified DOM. Alternatively, `data` could have been cached inside `edit_list` throughout. 
</p>
</details>

A simplification would be to enforce a single "working range", with accompanying `getWorkingRange` and `working_data`. These would be available for the final `insertFromComposition` event, indicating the full range that was modified, and the full data. A browser would not be allowed to include two disparate composition edits in the same composition. Those would each be enclosed in an individual `compositionstart` and `compositionend`. As examples, extending a composition left/right would be fine, as well as switching between several clauses in the same contiguous phrase. *All browsers but Chrome seem to do this already. With Chrome if you change cursor position to a different phrase, you get a `compositionupdate` but no `compositionend`.*

We would assume the browser has more innate knowledge of the IME composition working range, and what modifications it is going to make to the DOM. It can likely implement reversion much more efficiently, and it automates a very common use case for developers. 

If for some reason there is no way to efficiently revert the DOM, the DOM reversions could be an opt-in behavior. Opt-in could be signaled by `compositionborder=true` being set on the root `contenteditable` container. This signals to the browser that the developer is encapsulating nested elements with `compositionborder` where necessary, meaning less of the DOM needs to get reverted. Another idea is to have the reversion be lazy, with a `revertComposition()` method in `insertFromComposition` to request it; this might unroll the modifications using some internal mutation log, or using the undo/redo stack. 

**Emulating:** DOM reversion can *probably* be implemented in JavaScript. The only uncertain case is when a browser emits a multi-part composition with multiple `compositionend` events. It is not clear whether it is safe to manipulate the DOM inside `compositionend`. At the possible risk of breaking some IME behavior, developers could forcibly cancel the composition whenever `compositionend` occurs to prevent this (see previous section on emulating `requestCompositionEnd()`); thereafter, they can revert the DOM themselves using a log from `MutationObserver`.

While DOM reversion seems like it would be useful, it doesn't actually solve the more fundamental problem of style jank *during* composition. Arguably, the jank in styles between the browser editing the DOM and the developer repairing those edits makes any benefits of DOM reversion minimal.

Implementing `compositionborder`, and to a lesser extent `requestCompositionEnd()`, can solve the style jank problem. Additionally, they make implementing DOM reversion purely in JavaScript much easier. If the `compositionborder` surrounds purely textnodes, developers can just cache the original `textContent` themselves. For rarer cases where developers want to encapsulate styled elements, a clone can be made of the `compositionborder`, or a `MutationObserver` attached specifically to it. So in these cases, DOM reversion is convenient, but becomes far less important than it seems today.

The algorithm for generating `[{range, data}]` pairs can also be implemented in pure JavaScript, though not without some work. If a single "working range" was enforced in spec, emulating a `getWorkingRange` and `working_data` would also be simple.