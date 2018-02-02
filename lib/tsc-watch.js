#!/usr/bin/env node

'use strict';

const chalk = require('chalk');
const spawn = require('cross-spawn');
const killer = require('./killer');

const compilationStartedRegex = /Starting incremental compilation/;
const compilationCompleteRegex = / Compilation complete\. Watching for file changes\./;
const compilationFile = /TSFILE: (.*).js/;
const typescriptSuccessRegex = /Compilation complete/;
const typescriptWatchCommandRegex = /Watch input files\./;
const typescriptErrorRegex = /\(\d+,\d+\): error TS\d+:/;
const onSuccessCommandSyntax = ' --onSuccess COMMAND                                Run the COMMAND on each successful compilation';
const onFirstSuccessCommandSyntax = ' --onFirstSuccess COMMAND                           Run the COMMAND on the first successful compilation (Will not run the onSuccess)';
const onFailureCommandSyntax = ' --onFailure COMMAND                                Run the COMMAND on each failed compilation';
const newAdditionToSyntax = ['Watch input files. [always on]', onSuccessCommandSyntax, onFirstSuccessCommandSyntax, onFailureCommandSyntax].join('\n');

let hadErrors = false;
let firstTime = true;
let firstSuccessProcess = null;
let firstSuccessProcessExited = null;
let successProcess = null;
let successProcessExited = null;
let failureProcess = null;
let failureProcessExited = null;

function color(line) {
  if (typescriptErrorRegex.test(line)) {
    return chalk.red(line);
  }

  if (typescriptSuccessRegex.test(line) || typescriptWatchCommandRegex.test(line)) {
    return chalk.green(line);
  }

  return chalk.white(line);
}

function print(lines) {
  return lines.forEach(line => console.log(color(line)));
}

function cleanArgs(inputArgs) {
  return inputArgs
    .splice(2)
    .filter(arg => arg.toLowerCase() !== '--onsuccess')
    .filter(arg => arg.toLowerCase() !== '--onfailure')
    .filter(arg => arg.toLowerCase() !== '--onfirstsuccess');
}

function getCommandIdx(inputArgs, command) {
  const idx = inputArgs.indexOf(command);
  if (idx > -1 && idx + 1 < inputArgs.length) {
    return idx;
  } else {
    return -1;
  }
}

function runCommand(fullCommand, args) {
  if (fullCommand) {
    const parts = fullCommand.split(' ').filter(a => a.length > 0);
    if (args) {
      args.map(function (arg) {
        parts.push(arg)
      })
    }
    return spawn(parts[0], parts.slice(1), {
      stdio: 'inherit'
    })
  }
}

function killAllSuccessProcesses() {
  const promises = [];
  if (firstSuccessProcess) {
    promises.push(killer(firstSuccessProcess).then(() => firstSuccessProcess = null));
    promises.push(firstSuccessProcessExited.then(() => firstSuccessProcessExited = null));
  }

  if (successProcess) {
    promises.push(killer(successProcess).then(() => successProcess = null));
    promises.push(successProcessExited.then(() => successProcessExited = null));
  }

  return Promise.all(promises);
}

function killFailureProcess() {
  const promises = [];

  if (failureProcess) {
    promises.push(killer(failureProcess).then(() => failureProcess = null));
    promises.push(failureProcessExited.then(() => failureProcessExited = null));
  }

  return Promise.all(promises);
}

let allArgs = process.argv;
// onSuccess
let onSuccessCommandIdx = getCommandIdx(allArgs, '--onSuccess');
let onSuccessCommand = null;
if (onSuccessCommandIdx > -1) {
  onSuccessCommand = allArgs[onSuccessCommandIdx + 1];
  allArgs.splice(onSuccessCommandIdx, 2)
}

// onFirstSuccess
let onFirstSuccessCommandIdx = getCommandIdx(allArgs, '--onFirstSuccess');
let onFirstSuccessCommand = null;
if (onFirstSuccessCommandIdx > -1) {
  onFirstSuccessCommand = allArgs[onFirstSuccessCommandIdx + 1];
  allArgs.splice(onFirstSuccessCommandIdx, 2)
}

// onFailure
let onFailureCommandIdx = getCommandIdx(allArgs, '--onFailure');
let onFailureCommand = null;
if (onFailureCommandIdx > -1) {
  onFailureCommand = allArgs[onFailureCommandIdx + 1];
  allArgs.splice(onFailureCommandIdx, 2)
}

let args = cleanArgs(allArgs);
// args.push('--listEmittedFiles'); // force watch

const bin = require.resolve('typescript/bin/tsc');
console.log(args)
const tscProcess = spawn(bin, [...args]);
var filesChanged = [];

tscProcess.stdout.on('data', buffer => {
  const lines = buffer.toString()
    .split('\n')
    .filter(a => a.length > 0)
    // .filter(a => a !== '\r')
    .map(a => a.replace(typescriptWatchCommandRegex, newAdditionToSyntax));

  print(lines);

  const newCompilation = lines.some(line => compilationStartedRegex.test(line));
  if (newCompilation) {
    hadErrors = false;
  }

  const error = lines.some(line => typescriptErrorRegex.test(line));
  if (error) {
    hadErrors = true;
  }

  lines.forEach(function (line) {
    const hasFileChanged = compilationFile.test(line);
    if (hasFileChanged) {
      filesChanged.push(line.replace('TSFILE: ', ''));
    }
  });

  const compilationComplete = lines.some(line => compilationCompleteRegex.test(line));
  if (compilationComplete) {
    if (hadErrors) {
      killFailureProcess().then(() => {
        Signal.emitFail();
        if (onFailureCommand) {
          failureProcess = runCommand(onFailureCommand);
          failureProcessExited = new Promise(resolve => {
            failureProcess.on('exit', code => {
              resolve(code);
            });
          });
        }
      });
    } else {
      killAllSuccessProcesses().then(() => {
        Signal.emitSuccess(filesChanged);
        if (firstTime && onFirstSuccessCommand) {
          firstTime = false;
          firstSuccessProcess = runCommand(onFirstSuccessCommand, filesChanged);
          firstSuccessProcessExited = new Promise(resolve => {
            firstSuccessProcess.on('exit', code => {
              resolve(code);
            });
          });
        }

        if (onSuccessCommand) {
          successProcess = runCommand(onSuccessCommand, filesChanged);
          successProcessExited = new Promise(resolve => {
            successProcess.on('exit', code => {
              resolve(code);
            });
          });
        }
        filesChanged = [];
      });
    }
  }
});

const Signal = {
  send: typeof process.send === 'function' ? (...e) => process.send(...e) : () => {},
  _successStr: 'first_success',
  emitSuccess: (files) => {
    Signal.send({
      name: Signal._successStr,
      files: filesChanged
    });
    Signal._successStr = 'subsequent_success';
  },

  emitFail: () => Signal.send({
    name: 'compile_errors'
  })
};

tscProcess.on('exit', () => Promise.all([killAllSuccessProcesses(), killFailureProcess()]));
