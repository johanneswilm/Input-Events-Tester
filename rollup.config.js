import babel from '@rollup/plugin-babel';
import { terser } from "rollup-plugin-terser";

export default{
	input: "main.js",
	output: {
		file: "main.bundle.js",
		format: "iife"
	},
	plugins: [
		babel({ babelHelpers: 'bundled' }),
		// terser()
	]
};