'use strict';
const fs = require('fs');
const co = require('co');
require('array.prototype.includes');
require('array.prototype.find');
const log = require('../lib/logger')();
const exit = require('../lib/exit');
const loadVcl = require('../lib/loadVcl');

const VCL_VALIDATION_ERROR = Symbol();


function list(val) {
	return val.split(',');
}

function task (folder, opts) {
	let options = Object.assign({
		main: 'main.vcl',
		env: false,
		service: null,
		vars: [],
		verbose: false
	}, opts);

	if (options.env) {
		require('dotenv').load();
	}

	const log = require('../lib/logger')({verbose:options.verbose});

	return co(function*() {
		if (!options.service) {
			throw new Error('the service parameter is required set to the service id of a environment variable name');
		}

		if (!process.env.FASTLY_APIKEY) {
			throw new Error('FASTLY_APIKEY not found');
		}

		const fastlyApiKey = process.env.FASTLY_APIKEY;
		const serviceId = process.env[opts.service] || opts.service;

		if (!serviceId) {
			throw new Error('No service ');
		}

		const fastly = require('fastly')(fastlyApiKey, encodeURIComponent(serviceId), {verbose: false});

		// if service ID is needed use the given serviceId
		if (options.vars.includes('SERVICEID')) {
			process.env.SERVICEID = serviceId;
		}

		let vcls = loadVcl(folder, options.vars);

		// get the current service and active version
		let service = yield fastly.getServices().then(services => services.find(s => s.id === serviceId));
		let activeVersion = service.version;

		// clone new version from current active version
		log.verbose(`Cloning active version ${activeVersion} of ${service.name}`);
		let cloneResponse = yield fastly.cloneVersion(activeVersion);
		log.verbose(`Successfully cloned version ${cloneResponse.number}`);
		let newVersion = cloneResponse.number;
		log.info('Cloned new version');

		// delete old vcl
		let oldVcl = yield fastly.getVcl(newVersion);
		yield Promise.all(oldVcl.map(vcl => {
			log.verbose(`Deleting "${vcl.name}" for version ${newVersion}`);
			return fastly.deleteVcl(newVersion, vcl.name);
		}));
		log.info('Deleted old vcl');

		//upload new vcl
		log.info(`Uploading new VCL`);
		yield Promise.all(vcls.map(vcl => {
			log.verbose(`Uploading new VCL ${vcl.name} with version ${newVersion}`);
			return fastly.updateVcl(newVersion, {
				name: vcl.name,
				content: vcl.content
			});
		}));

		// set the main vcl file
		log.info(`Set "${options.main}" as the main entry point`);
		yield fastly.setVclAsMain(newVersion, options.main);

		// validate
		log.verbose(`Validate version ${newVersion}`);
		let validationResponse = yield fastly.validateVersion(newVersion)
			.catch(err => {
				let error = new Error('VCL Validation Error');
				error.type = VCL_VALIDATION_ERROR;
				error.validation = err;
				throw err;
			});
		if (validationResponse.status === 'ok') {
			log.info(`Version  ${newVersion} looks ok`);
			yield fastly.activateVersion(newVersion);
		} else {
			throw new Error('VCL failed validation for some unknown reason');
		}

		log.success('Your VCL has been deployed.  Have a nice cup of tea and relax');
		log.art('tea', 'success');


	}).catch((err => {
		if(err.type && err.type === VCL_VALIDATION_ERROR){
			log.error('VCL Validation Error');
			log.error(err.validation);
		}else{
			log.error(err.stack);
		}
		exit('Bailing...');
	}));
}


module.exports = function (program, utils) {
	program
		.command('deploy-vcl [folder]')
		.description('Deploys VCL in [folder] to the specified fastly service.  Requires FASTLY_KEY env var')
		.option('-m, --main <main>', 'Set the name of the main vcl file (the entry point).  Defaults to "main.vcl"')
		.option('-v, --vars <vars>', 'A way of injecting environment vars into the VCL.  So if you pass --vars AUTH_KEY,FOO the values {$AUTH_KEY} and ${FOO} in the vcl will be replaced with the values of the environmemnt variable.  If you include SERVICEID it will be populated with the current --service option', list)
		.option('-e, --env', 'Load environment variables from local .env file (use when deploying from a local machine')
		.option('-s, --service <service>', 'REQUIRED.  The ID of the fastly service to deploy to.')
		.option('-V --verbose', 'Verbose log output')
		.action(function(folder, options) {
			if (folder) {
				task(folder, options).catch(exit);
			} else {
				exit('Please provide a folder where the .vcl is located');
			}
		});
};

module.exports.task = task;
