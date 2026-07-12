import * as path from 'path'
import * as webpack from 'webpack'
import CopyWebpackPlugin from 'copy-webpack-plugin'
import { CleanWebpackPlugin } from 'clean-webpack-plugin'
import TsconfigPathsPlugin from 'tsconfig-paths-webpack-plugin'
import MiniCssExtractPlugin from 'mini-css-extract-plugin'
import * as fs from 'fs'

const provider_registry = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../packages/shared/src/providers.json'),
    'utf8'
  )
) as { providers: Array<{ manifest_matches: string[] }> }

const generated_manifest = (content: Buffer) => {
  const manifest = JSON.parse(content.toString('utf8'))
  manifest.content_scripts[0].matches = Array.from(
    new Set(
      provider_registry.providers.flatMap(
        (provider) => provider.manifest_matches
      )
    )
  )
  return JSON.stringify(manifest, null, 2)
}

const config = (_: any, argv: Record<string, any>): webpack.Configuration => {
  const is_production = argv.mode == 'production'

  const plugins: webpack.WebpackPluginInstance[] = [
    new MiniCssExtractPlugin({
      filename: '[name].css'
    }) as unknown as webpack.WebpackPluginInstance,
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'src/manifest.json',
          to: 'manifest.json',
          transform: generated_manifest
        },
        { from: 'src/icons', to: 'icons' },
        { from: 'src/views/popup/index.html', to: 'popup.html' },
        { from: 'src/views/popup/index.css', to: 'index.css' }
      ]
    })
  ]

  if (is_production) {
    plugins.push(new CleanWebpackPlugin())
  }

  return {
    entry: {
      'send-prompt-content-script':
        './src/content-scripts/send-prompt-content-script/send-prompt-content-script.ts',
      background: './src/background/main.ts',
      popup: './src/views/popup/App.tsx'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js'
    },
    cache: {
      type: 'filesystem',
      buildDependencies: {
        config: [__filename]
      }
    },
    module: {
      rules: [
        {
          test: /\.(ts|tsx)$/,
          use: 'ts-loader',
          exclude: /node_modules/
        },
        {
          test: /\.css$/,
          use: [MiniCssExtractPlugin.loader, 'css-loader']
        },
        {
          test: /\.scss$/,
          use: [
            MiniCssExtractPlugin.loader,
            {
              loader: 'css-loader',
              options: {
                modules: {
                  localIdentName: '[name]__[local]__[hash:base64:5]'
                },
                importLoaders: 1
              }
            },
            'sass-loader'
          ]
        }
      ]
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      plugins: [new TsconfigPathsPlugin()]
    },
    plugins,
    stats: 'errors-warnings'
  }
}

export default config
