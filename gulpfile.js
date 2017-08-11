/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http:polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http:polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http:polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http:polymer.github.io/PATENTS.txt
 */

/* eslint-env node */
'use strict';

const gulp = require('gulp');
const gulpif = require('gulp-if');
// const runseq = require('run-sequence');
const del = require('del');
const mergeStream = require('merge-stream');
const closure = require('google-closure-compiler').gulp();
const Polymer = require('polymer-build');
const lazypipe = require('lazypipe');
const size = require('gulp-size');

const {Transform} = require('stream');

/**
 * Closure will only emit one file, but polymer-build is expecting an equal number of files in and out
 * Given a list of files, emit the missing ones back into the stream as empty files
 */
class BackfillStream extends Transform {
  constructor(fileList) {
    super({objectMode: true});
    this.fileList = fileList;
  }
  _transform(file, enc, cb) {
    if (this.fileList) {
      const origFile = this.fileList.shift();
      file.path = origFile.path;
    }
    cb(null, file);
  }
  _flush(cb) {
    if (this.fileList && this.fileList.length > 0) {
      this.fileList.forEach((oldFile) => {
        let newFile = oldFile.clone({deep: true, contents: false});
        newFile.contents = new Buffer('');
        this.push(newFile);
      });
    }
    cb();
  }
}

gulp.task('clean', () => del('dist'));

const dom5 = require('dom5'); const path = require('path');

let firstImportFinder = dom5.predicates.AND(dom5.predicates.hasTagName('link'), dom5.predicates.hasAttrValue('rel', 'import'));

class AddClosureTypeImport extends Transform {
  constructor(entryFileName, typeFileName) {
    super({objectMode: true});
    this.target = path.resolve(entryFileName);
    this.importPath = path.resolve(typeFileName);
  }
  _transform(file, enc, cb) {
    if (file.path === this.target) {
      let contents = file.contents.toString();
      let html = dom5.parse(contents, {locationInfo: true});
      let firstImport = dom5.query(html, firstImportFinder);
      if (firstImport) {
        let importPath = path.relative(path.dirname(this.target), this.importPath);
        let importLink = dom5.constructors.element('link');
        dom5.setAttribute(importLink, 'rel', 'import');
        dom5.setAttribute(importLink, 'href', importPath);
        dom5.insertBefore(firstImport.parentNode, firstImport, importLink);
        file.contents = Buffer(dom5.serialize(html));
      }
    }
    cb(null, file);
  }
}

gulp.task('closure', ['clean'], () => {

  let shell, splitRx, joinRx, addClosureTypes;

  function config(path) {
    shell = path;
    joinRx = new RegExp(path.split('/').join('\\/'));
    splitRx = new RegExp(joinRx.source + '_script_\\d+\\.js$');
    addClosureTypes = new AddClosureTypeImport(shell, 'bower_components/polymer/externs/polymer-closure-types.html');
  }

  config('app.html');

  const project = new Polymer.PolymerProject({
    entrypoint: 'index.html',
    shell: `./${shell}`,
    fragments: [
      'bower_components/shadycss/apply-shim.html',
      'bower_components/shadycss/custom-style-interface.html',
    ],
    extraDependencies: [
      addClosureTypes.importPath,
      "bower_components/webcomponentsjs/webcomponents-lite.js",
      "bower_components/webcomponentsjs/custom-elements-es5-adapter.js"
    ]
  });

  const closureStream = closure({
    compilation_level: 'ADVANCED',
    language_in: 'ES6_STRICT',
    language_out: 'ES5_STRICT',
    isolation_mode: 'IIFE',
    assume_function_wrapper: true,
    rewrite_polyfills: false,
    new_type_inf: true,
    polymer_version: 2,
    formatting: 'PRETTY_PRINT',
    externs: [
      'bower_components/shadycss/externs/shadycss-externs.js',
      'bower_components/polymer/externs/webcomponents-externs.js',
      'bower_components/polymer/externs/closure-types.js',
      'bower_components/polymer/externs/polymer-externs.js',
    ],
    extra_annotation_name: [
      'appliesMixin',
      'customElement',
      'mixinClass',
      'mixinFunction',
      'polymer'
    ]
  });

  const closurePipeline = lazypipe()
    .pipe(() => closureStream)
    .pipe(() => new BackfillStream(closureStream.fileList_))

  // process source files in the project
  const sources = project.sources();

  // process dependencies
  const dependencies = project.dependencies();

  // merge the source and dependencies streams to we can analyze the project
  const mergedFiles = mergeStream(sources, dependencies);

  const splitter = new Polymer.HtmlSplitter();
  return mergedFiles
    .pipe(addClosureTypes)
    .pipe(project.bundler())
    .pipe(splitter.split())
    .pipe(gulpif(splitRx, closurePipeline()))
    .pipe(splitter.rejoin())
    .pipe(project.addCustomElementsEs5Adapter())
    .pipe(gulpif(joinRx, size({title: 'bundle size', gzip: true, showTotal: false, showFiles: true})))
    .pipe(gulp.dest('dist'))
});

gulp.task('default', ['closure']);