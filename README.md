# Input Events Tester
[View the demo page](https://johanneswilm.github.io/Input-Events-Tester/), or clone and run yourself.

Use this to test Input Events Level 1/2 support and quirks in browsers.
For reference, see the published [W3C specs](https://www.w3.org/TR/input-events-2/), or the [W3C github repo](https://github.com/w3c/input-events/) to see discussions and undocumented specs.

To add test cases, simply modify `index.html`. The JavaScript files are transpiled/bundled using rollup/babel, to work with older browsers that have Input Events implemented:

```sh
npm install
npm run bundle
```

