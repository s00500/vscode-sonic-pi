// MIT License

// Copyright (c) 2020 Luis Lloret

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import * as vscode from 'vscode'
import { TextDecoder } from 'util'
const fs = require('fs')
const os = require('os')
const child_process = require('child_process')
import { OscSender } from './oscsender'
const OSC = require('osc-js')
const utf8 = require('utf8')
const { v4: uuidv4 } = require('uuid')
import { Config } from './config'
import { Range, TextEditor, window } from 'vscode'
const readline = require('readline')

export class Main {
	rootPath: string
	rubyPath: string
	daemonLauncherPath: string
	daemonLogPath: string
	samplePath: string
	spUserPath: string
	spUserTmpPath: string
	logPath: string
	serverErrorLogPath: string
	serverOutputLogPath: string
	guiLogPath: string
	processLogPath: string
	scsynthLogPath: string

	onRunStarted = new vscode.EventEmitter<number>()
	onRunEnded = new vscode.EventEmitter<number>()

	guiSendToServerPort: number
	daemonPort: number
	guiListenToServerPort: number
	serverListenToGuiPort: number
	serverOscCuesPort: number
	serverSendToGuiPort: number
	scsynthPort: number
	scsynthSendPort: number

	portsInitalized: Promise<OscSender>
	portsInitalizedResolver!: (sender: OscSender) => void

	logOutput: vscode.OutputChannel
	cuesOutput: vscode.OutputChannel

	serverStarted: boolean

	platform: string
	guiUuid: any
	config: any

	runOffset: number

	errorHighlightDecorationType = vscode.window.createTextEditorDecorationType({
		border: '2px solid red',
	})

	constructor() {
		// Set up path defaults based on platform
		this.platform = os.platform()
		if (this.platform === 'win32') {
			this.rootPath = 'C:/Program Files/Sonic Pi'
			this.rubyPath = this.rootPath + '/app/server/native/ruby/bin/ruby.exe'
		} else if (this.platform === 'darwin') {
			this.rootPath = '/Applications/Sonic Pi.app/Contents/Resources'
			this.rubyPath = '/usr/bin/ruby' // was this.rootPath + '/app/server/native/ruby/bin/ruby'
		} else {
			this.rootPath = '/home/user/sonic-pi'
			this.rubyPath = 'ruby'
		}
		this.config = new Config()

		// Override default root path if found in settings
		if (this.config.sonicPiRootDirectory()) {
			this.rootPath = this.config.sonicPiRootDirectory()
		}

		this.portsInitalized = new Promise((r) => (this.portsInitalizedResolver = r))

		if (this.config.commandPath()) {
			this.rubyPath = this.config.commandPath()
		}

		console.log('Using Sonic Pi root directory: ' + this.rootPath)
		console.log('Using ruby: ' + this.rubyPath)

		this.daemonLauncherPath = this.rootPath + '/server/ruby/bin/daemon.rb'

		if (this.platform === 'win32') {
			this.daemonLauncherPath = this.rootPath + '/app/server/ruby/bin/daemon.rb'
		}

		this.spUserPath = this.sonicPiHomePath() + '/.sonic-pi'
		this.daemonLogPath = this.spUserPath + '/log/daemon.log'

		this.samplePath = this.rootPath + '/etc/samples'
		this.spUserTmpPath = this.spUserPath + '/.writableTesterPath'
		this.logPath = this.spUserPath + '/log'

		this.serverErrorLogPath = this.logPath + '/server-errors.log'
		this.serverOutputLogPath = this.logPath + '/server-output.log'

		this.guiLogPath = this.logPath + '/gui.log'

		this.processLogPath = this.logPath + '/processes.log'
		this.scsynthLogPath = this.logPath + '/scsynth.log'

		this.daemonPort = -1
		this.guiSendToServerPort = -1
		this.guiListenToServerPort = -1

		this.serverListenToGuiPort = -1
		this.serverOscCuesPort = -1

		this.serverSendToGuiPort = -1

		this.scsynthPort = -1
		this.scsynthSendPort = -1

		this.runOffset = 0

		// attempt to create log directory
		if (!fs.existsSync(this.logPath)) {
			fs.mkdirSync(this.logPath, { recursive: true })
		}

		this.cuesOutput = vscode.window.createOutputChannel('Cues')
		this.logOutput = vscode.window.createOutputChannel('Log')
		this.cuesOutput.show()
		this.logOutput.show()

		this.serverStarted = false

		// this.oscSender = new OscSender()

		// create an uuid for the editor
		this.guiUuid = -1

		// watch to see if the user opens a ruby or custom file and we need to start the server
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			let launchAuto = this.config.launchSonicPiServerAutomatically()
			for (let i = 0; i < editors.length; i++) {
				if (
					launchAuto === 'ruby' &&
					editors[i].document.languageId === 'sonic-pi' &&
					!this.serverStarted
				) {
					this.startServer()
					break
				}
				if (launchAuto === 'custom') {
					let customExtension = this.config.launchSonicPiServerCustomExtension()
					if (!customExtension) {
						void vscode.window
							.showErrorMessage(
								'Launch is set to custom, but custom extension is empty.',
								'Go to settings',
							)
							.then((item) => {
								if (item) {
									void vscode.commands.executeCommand(
										'workbench.action.openSettings',
										'sonicpieditor.launchSonicPiServerCustomExtension',
									)
								}
							})
					} else if (
						editors[i].document.fileName.endsWith(customExtension) &&
						!this.serverStarted
					) {
						this.startServer()
						break
					}
				}
			}
		})

		// Update the mixer on the server if there are configuration changes
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('sonicpieditor')) {
				this.updateMixerSettings()
			}
		})
	}

	checkSonicPiPath() {
		if (!fs.existsSync(this.daemonLauncherPath)) {
			void vscode.window
				.showErrorMessage('The Sonic Pi root path is not properly configured.', 'Go to settings')
				.then((item) => {
					if (item) {
						void vscode.commands.executeCommand(
							'workbench.action.openSettings',
							'vscode-sonic-pi.sonicPiRootDirectory',
						)
					}
				})
		}
	}

	sonicPiHomePath() {
		return os.homedir()
	}

	async startServer() {
		if (this.serverStarted) {
			return
		}
		this.serverStarted = true

		// Initialise the Sonic Pi server
		this.logOutput.appendLine('Will start server')

		await this.startRubyServer() // Start server using daemon script... could actually take ports form here too....
		this.logOutput.append('Done starting server!')
		//await this.initAndCheckPorts()
		this.startKeepAlive()
		this.setupOscReceiver()
	}

	log(str: string) {
		this.logOutput.appendLine(str)
	}

	cueLog(str: string) {
		this.cuesOutput.appendLine(str)
	}

	// This is where the incoming OSC messages are processed.
	// We are processing most of the incoming OSC messages, but not everything yet.
	setupOscReceiver() {
		let osc = new OSC({
			plugin: new OSC.DatagramPlugin({ open: { port: this.guiListenToServerPort, host: '127.0.0.1' } }),
		})
		osc.open()

		osc.on('/log/info', (message: { args: any }) => {
			// this.logOutput.appendLine('Got /log/info' + ' -> ' + message.args[0] + ', ' + message.args[1])
			const parse = /(Completed|Starting) run (\d+)/.exec(message.args[1])
			if (parse) {
				const num = +parse[2]
				if (parse[1] === 'Completed') this.onRunEnded.fire(num)
				else if (parse[1] === 'Starting') this.onRunStarted.fire(num)
			}
			this.log(message.args[1])
		})

		osc.on('/incoming/osc', (message: { args: any }) => {
			// console.log(
			//  	'Got /incoming/osc' +
			//  		' -> ' +
			//  		message.args[0] +
			//  		', ' +
			//  		message.args[1] +
			//  		', ' +
			//  		message.args[2] +
			//  		', ' +
			//  		message.args[3],
			//  )
			this.cueLog(message.args[2] + ': ' + message.args[3])
		})

		osc.on('/log/multi_message', (message: any) => {
			// console.log('Got /log/multi_message')
			this.processMultiMessage(message)
		})

		osc.on('/syntax_error', (message: { args: any }) => {
			// console.log(
			// 	'Got /syntax_error' +
			// 		message.args[0] +
			// 		', ' +
			// 		message.args[1] +
			// 		', ' +
			// 		message.args[2] +
			// 		', ' +
			// 		message.args[3] +
			// 		', ' +
			// 		message.args[4],
			// )
			this.processSyntaxError(message)
		})

		osc.on('/error', (message: any) => {
			// console.log('Got /error')
			this.processError(message)
		})

		//osc.on('*', (message: {address: string}) => {
		//    this.logOutput.appendLine("Got message of type: " + message.address);
		//});
	}

	// Show information about the syntax error to the user
	processSyntaxError(message: { args: any }) {
		let job_id = message.args[0]
		let desc = message.args[1]
		let error_line = message.args[2]
		let line = message.args[3] + this.runOffset

		void vscode.window
			.showErrorMessage(
				'Syntax error on Ajob ' + job_id + ': ' + desc + '\nLine ' + line + ': ' + error_line,
				'Goto error',
			)
			.then((item) => {
				if (item) {
					let errorHighlight: vscode.DecorationOptions[] = []
					let editor = vscode.window.activeTextEditor!
					let range = editor.document.lineAt(line - 1).range
					editor.selection = new vscode.Selection(range.start, range.end)
					editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
					errorHighlight.push({ range })
					editor.setDecorations(this.errorHighlightDecorationType, errorHighlight)
				}
			})
	}

	// Show information about the error to the user
	processError(message: { args: any }) {
		let job_id = message.args[0]
		let desc = message.args[1]
		let backtrace = message.args[2]
		let line = message.args[3] + this.runOffset

		this.logOutput.appendLine(
			'Error on job ' + job_id + ': ' + desc + '\nLine ' + line + ': ' + backtrace,
		)
		//void vscode.window
		//	.showErrorMessage(
		//		'Error on job ' + job_id + ': ' + desc + '\nLine ' + line + ': ' + backtrace,
		//		'Goto error',
		//	)
		//	.then((item) => {
		//		if (item) {
		let errorHighlight: vscode.DecorationOptions[] = []
		let editor = vscode.window.activeTextEditor!
		let range = editor.document.lineAt(line - 1).range
		editor.selection = new vscode.Selection(range.start, range.end)
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
		errorHighlight.push({ range })
		editor.setDecorations(this.errorHighlightDecorationType, errorHighlight)
		//		}
		//	})
	}

	// Process an incoming multi-message
	processMultiMessage(message: { args: any }) {
		let job_id = message.args[0]
		let thread_name = message.args[1]
		let runtime = message.args[2]
		let count = message.args[3]

		let toShow = '{run: ' + job_id + ', time: ' + runtime
		if (thread_name) {
			toShow += ', thread: ' + thread_name
		}
		toShow += '}'
		this.logOutput.appendLine(toShow)

		toShow = ''
		for (let i = 0; i < count; i++) {
			//let type = message.args[4 + (2*i)];
			let str = message.args[4 + 1 + 2 * i]
			let lines = str.split(/\r?\n/)
			if (!str) {
				toShow = ' |'
			} else if (i === count - 1) {
				toShow = ' └─ '
			} else {
				toShow = ' ├─ '
			}
			this.logOutput.append(toShow)

			lines.forEach((line: string) => {
				this.logOutput.appendLine(line)
			})
		}
	}

	// This is where we see what ports to use, calling a ruby script
	async initAndCheckPorts() {
		// Clear out old tasks from previous sessions if they still exist
		// in addtition to clearing out the logs
		// this.log('[GUI] - Cleaning old sessions...')
		// child_process.spawnSync(this.rubyPath, [this.initScriptPath])

		// Discover the port numbers
		let port_map = new Map<string, number>()
		this.log('[GUI] - Discovering port numbers...')

		// Read log file
		const inputStream = fs.createReadStream(this.daemonLogPath)
		let lineReader = readline.createInterface({
			input: inputStream,
			terminal: false,
		})
		const tokenPre = 'log: UTF-8, UTF-8, Token: '
		for await (let line of lineReader) {
			if (line.includes(tokenPre)) {
				let t = line.substring(line.indexOf(tokenPre) + tokenPre.length)
				this.guiUuid = parseInt(t) // Add token
			} else if (line.includes('spider-listen-to-gui')) {
				if (line.includes('{')) {
					line = line.substring(line.indexOf('{') + 1)
				}
				if (line.includes('}')) {
					line = line.replace('}', '')
				}
				let port_strings = line.split(', ')
				port_strings.forEach((port_string: string) => {
					let tokens = port_string.split('=>')
					let key = tokens[0].replace('"', '').replace('"', '')
					port_map.set(key, parseInt(tokens[1]))
				})
			}
		}

		// Other Unused Ports
		// tau 37468
		// spider 37469
		// phx 37470
		// spider-listen-to-tau 37472

		this.daemonPort = port_map.get('daemon')!

		this.guiSendToServerPort = port_map.get('gui-send-to-spider')!
		this.guiListenToServerPort = port_map.get('gui-listen-to-spider')!
		this.serverListenToGuiPort = port_map.get('spider-listen-to-gui')!
		this.serverOscCuesPort = port_map.get('osc-cues')!
		this.serverSendToGuiPort = port_map.get('spider-send-to-gui')!
		this.scsynthPort = port_map.get('scsynth')!
		this.scsynthSendPort = port_map.get('scsynth-send')!

		// this.erlangRouterPort = port_map.get('erlang-router')!
		// this.oscMidiOutPort = port_map.get('osc-midi-out')!
		// this.oscMidiInPort = port_map.get('osc-midi-in')!
		// this.websocketPort = port_map.get('websocket')!

		this.portsInitalizedResolver(new OscSender(this.serverListenToGuiPort))
		return true
	}

	startKeepAlive() {
		const daemonSender = new OscSender(this.daemonPort)
		console.log('Sending Keepalive to', this.daemonPort)
		setInterval(() => {
			let message = new OSC.Message('/daemon/keep-alive', parseInt(this.guiUuid))
			daemonSender.send(message)
		}, 1000)
	}

	// This is the main part of launching Sonic Pi's backend
	async startRubyServer(): Promise<void> {
		let args: String[] = [this.daemonLauncherPath] // No need for launch args on the new daemon script

		return new Promise<void>((resolve, reject) => {
			let ruby_server = child_process.spawn(this.rubyPath, args)
			ruby_server.stdout.on('data', (data: any) => {
				// console.log(`stdout: ${data}`)
				this.logOutput.appendLine(`Daemon Out: ${data}`)
				// Start the keepalive loop
				let ports = data.toString().split(' ')

				// Order: daemon-keep-alive gui-listen-to-server gui-send-to-server scsynth osc-cues tau-api tau-phx token

				this.daemonPort = parseInt(ports[0])
				this.guiListenToServerPort = parseInt(ports[1])
				this.serverSendToGuiPort = parseInt(ports[2])
				this.guiUuid = parseInt(ports[7])
				this.portsInitalizedResolver(new OscSender(this.serverSendToGuiPort))

				resolve() // Assume stuff is ok instantly....

				//if (data.toString().match(/.*Sonic Pi Server successfully booted.*/)) { // TODO: Fix mixer setting stuff
				//	this.updateMixerSettings()
				//}
			})

			ruby_server.stderr.on('data', (data: any) => {
				// console.log(`stdserr: ${data}`)
				this.logOutput.appendLine(`Daemon Err: ${data}`)
			})
		})
	}

	updateMixerSettings() {
		let invert_stereo = this.config.invertStereo()
		let force_mono = this.config.forceMono()
		if (invert_stereo) {
			this.mixerInvertStereo()
		} else {
			this.mixerStandardStereo()
		}

		if (force_mono) {
			this.mixerMonoMode()
		} else {
			this.mixerStereoMode()
		}
	}

	sendOsc(message: any) {
		void this.portsInitalized.then((sender) => {
			sender.send(message)
		})
	}

	runCode(code: string, offset: number = 0) {
		// The offset represents the line number of the selection, so we can apply it when we just send a
		// selection to Sonic Pi. If we send the full buffer, then this is 0.
		this.runOffset = offset
		if (this.config.logClearOnRun()) {
			this.logOutput.clear()
		}
		if (this.config.safeMode()) {
			code = 'use_arg_checks true #__nosave__ set by Qt GUI user preferences.\n' + code
		}
		code = utf8.encode(code)
		this.clearErrorHighlight()
		let message = new OSC.Message('/run-code', parseInt(this.guiUuid), code)
		this.sendOsc(message)
	}

	flashCode(editor: TextEditor, isWhole: boolean) {
		const range = isWhole ? this.getWholeRange(editor) : this.getSelectedRange(editor)
		const flashDecorationType = window.createTextEditorDecorationType({
			backgroundColor: this.config.flashBackgroundColor(),
			color: this.config.flashTextColor(),
		})
		editor.setDecorations(flashDecorationType, [range])
		setTimeout(function () {
			flashDecorationType.dispose()
		}, 250)
	}

	private getWholeRange(editor: TextEditor): Range {
		let startPos = editor.document.positionAt(0)
		let endPos = editor.document.positionAt(editor.document.getText().length - 1)
		return new Range(startPos, endPos)
	}

	private getSelectedRange(editor: TextEditor): Range {
		return new Range(editor.selection.anchor, editor.selection.active)
	}

	stopAllJobs() {
		let message = new OSC.Message('/stop-all-jobs', this.guiUuid)
		this.sendOsc(message)
	}

	startRecording() {
		let message = new OSC.Message('/start-recording', this.guiUuid)
		this.sendOsc(message)
	}

	stopRecording() {
		let message = new OSC.Message('/stop-recording', this.guiUuid)
		this.sendOsc(message)
	}

	saveRecording(path: string) {
		let message = new OSC.Message('/save-recording', this.guiUuid, path)
		this.sendOsc(message)
	}

	deleteRecording() {
		let message = new OSC.Message('/delete-recording', this.guiUuid)
		this.sendOsc(message)
	}

	mixerInvertStereo() {
		let message = new OSC.Message('/mixer-invert-stereo', this.guiUuid)
		this.sendOsc(message)
	}

	mixerStandardStereo() {
		let message = new OSC.Message('/mixer-standard-stereo', this.guiUuid)
		this.sendOsc(message)
	}

	mixerMonoMode() {
		let message = new OSC.Message('/mixer-mono-mode', this.guiUuid)
		this.sendOsc(message)
	}

	mixerStereoMode() {
		let message = new OSC.Message('/mixer-stereo-mode', this.guiUuid)
		this.sendOsc(message)
	}

	// Remove the error highlight
	clearErrorHighlight() {
		vscode.window.activeTextEditor?.setDecorations(this.errorHighlightDecorationType, [])
	}
}
