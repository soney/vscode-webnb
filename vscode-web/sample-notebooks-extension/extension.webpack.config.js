// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');


module.exports = /** @type WebpackConfig */ {
	context: __dirname,
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
	target: 'webworker', // extensions run in a webworker context
	entry: {
		extension: './src/extension.ts',
	},
	resolve: {
		mainFields: ['module', 'main'],
		extensions: ['.ts', '.js'], // support ts-files and js-files
		alias: {
		}
	},
	module: {
		rules: [{
			test: /\.ts$/,
			exclude: /node_modules/,
			use: [{
				// configure TypeScript loader:
				// * enable sources maps for end-to-end source maps
				loader: 'ts-loader',
				options: {
					"configFile": path.join(__dirname, "extension.tsconfig.json"),
					"compilerOptions": {
						"strictNullChecks": true,
						"module": "commonjs",
						"target": "es2020",
						"lib": ["es2020", "WebWorker"],
						"outDir": "out",
						"sourceMap": true,
						"strict": true,
						"rootDir": "./src",
						"types": ["node"],
						"resolveJsonModule": true
					}
				}
			}]
		}]
	},
	externals: {
		'vscode': 'commonjs vscode', // ignored because it doesn't exist
	},
	performance: {
		hints: false
	},
	output: {
		filename: 'extension.js',
		path: path.join(__dirname, 'dist'),
		libraryTarget: 'commonjs'
	},
	devtool: 'source-map'
};