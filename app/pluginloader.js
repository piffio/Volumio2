'use strict';

var fs = require('fs-extra');
var HashMap = require('hashmap');
var libQ=require('kew');

module.exports = PluginLoader;

function PluginLoader(ccommand, server) {
  var self = this;
  self.logger = ccommand.logger;
  self.pluginManager = ccommand.pluginManager;

}

PluginLoader.prototype.startPlugins = function() {
  this.logger.info("-------------------------------------------");
  this.logger.info("-----      Core plugins startup        ----");
  this.logger.info("-------------------------------------------");

  this.loadCorePlugins();
  this.startCorePlugins();

  this.logger.info("-------------------------------------------");
  this.logger.info("-----    MyVolumio plugins startup     ----");
  this.logger.info("-------------------------------------------");

  this.loadMyVolumioPlugins();
  this.startMyVolumioPlugins();
}



PluginLoader.prototype.initializeConfiguration = function (package_json, pluginInstance, folder) {
	var self = this;

	if (pluginInstance.getConfigurationFiles != undefined) {
		var configFolder = self.pluginManager.configurationFolder + package_json.volumio_info.plugin_type + "/" + package_json.name + '/';

		var configurationFiles = pluginInstance.getConfigurationFiles();
		for (var i in configurationFiles) {
			var configurationFile = configurationFiles[i];

			var destConfigurationFile = configFolder + configurationFile;
			if (!fs.existsSync(destConfigurationFile)) {
				fs.copySync(folder + '/' + configurationFile, destConfigurationFile);
			}
			else
			{
				var requiredConfigParametersFile=folder+'/requiredConf.json';
				if (fs.existsSync(requiredConfigParametersFile)) {
					self.logger.info("Applying required configuration parameters for plugin "+package_json.name);
					self.pluginManager.checkRequiredConfigurationParameters(requiredConfigParametersFile,destConfigurationFile);
				}

			}
		}

	}
};

PluginLoader.prototype.loadCorePlugin = function (folder) {
	var self = this;
	var defer=libQ.defer();

	var package_json = self.pluginManager.getPackageJson(folder);

	var category = package_json.volumio_info.plugin_type;
	var name = package_json.name;

	var key = category + '.' + name;
	var configForPlugin = self.pluginManager.config.get(key + '.enabled');

	var shallStartup = configForPlugin != undefined && configForPlugin == true;
	if (shallStartup == true) {
		self.logger.info('Loading plugin \"' + name + '\"...');

		var pluginInstance = null;
		var context=new (require(__dirname+'/pluginContext.js'))(self.pluginManager.coreCommand, self.pluginManager.websocketServer,self.pluginManager.configManager);
		context.setEnvVariable('category', category);
		context.setEnvVariable('name', name);

		try {
            pluginInstance = new (require(folder + '/' + package_json.main))(context);
            self.initializeConfiguration(package_json, pluginInstance, folder);
		} catch(e) {
			self.logger.error('!!!! WARNING !!!!');
            self.logger.error('The plugin ' + category + '/' + name + ' failed to load, setting it to stopped. Error: ' + e);
            self.logger.error('Stack trace: ' + e.stack);
            self.logger.error('!!!! WARNING !!!!');
            self.pluginManager.coreCommand.pushToastMessage('error' , name + ' Plugin', self.coreCommand.getI18nString('PLUGINS.PLUGIN_START_ERROR'));
            self.pluginManager.config.set(category + '.' + name + '.status', "STOPPED");
        }

		var pluginData = {
			name: name,
			category: category,
			folder: folder,
			instance: pluginInstance
		};


		if (pluginInstance && pluginInstance.onVolumioStart !== undefined){
			var myPromise = pluginInstance.onVolumioStart();

			if (Object.prototype.toString.call(myPromise) != Object.prototype.toString.call(libQ.resolve())) {
				// Handle non-compliant onVolumioStart(): push an error message and disable plugin
				//self.coreCommand.pushToastMessage('error',name + " Plugin","This plugin has failing init routine. Please install updated version, or contact plugin developper");
				self.logger.error("ATTENTION!!!: Plugin " + name + " does not return adequate promise from onVolumioStart: please update!");
				myPromise = libQ.resolve();  // passing a fake promise to avoid crashes in new promise management
			}

			self.pluginManager.corePlugins.set(key, pluginData);  // set in any case, so it can be started/stopped

			defer.resolve();
			return myPromise;
		}
		else {
			self.pluginManager.corePlugins.set(key, pluginData);
			defer.resolve();
		}

	}
	else
	{
	 	self.logger.info("Plugin " + name + " is not enabled");
		defer.resolve();
	}

	return defer.promise;

};


PluginLoader.prototype.loadCorePlugins = function () {
	var self = this;
	var defer_loadList=[];
	var priority_array = new HashMap();

for (var ppaths in self.pluginManager.pluginPath) {
		var folder = self.pluginManager.pluginPath[ppaths];
		self.logger.info('Loading plugins from folder ' + folder);

		if (fs.existsSync(folder)) {
			var pluginsFolder = fs.readdirSync(folder);
			for (var i in pluginsFolder) {
				var groupfolder = folder + '/' + pluginsFolder[i];

				var stats = fs.statSync(groupfolder);
				if (stats.isDirectory()) {

					var folderContents = fs.readdirSync(groupfolder);
					for (var j in folderContents) {
						var subfolder = folderContents[j];

						//loading plugin package.json
						var pluginFolder = groupfolder + '/' + subfolder;

						var package_json = self.pluginManager.getPackageJson(pluginFolder);
						if(package_json!==undefined)
						{
							var boot_priority = package_json.volumio_info.boot_priority;
							if (boot_priority == undefined)
								boot_priority = 100;

							var plugin_array = priority_array.get(boot_priority);
							if (plugin_array == undefined)
								plugin_array = [];

							plugin_array.push(pluginFolder);
							priority_array.set(boot_priority, plugin_array);

							if (package_json.volumio_info.is_my_music_plugin) {
								self.pluginManager.addMyMusicPlugin(package_json);
							}
						}

					}
				}

			}
		}

	}

/*
    each plugin's onVolumioStart() is launched by priority order.
	Note: there is no resolution strategy: each plugin completes
	at it's own pace, and in whatever order.
	Should completion order matter, a new promise strategy should be
	implemented below (chain by boot-priority order, or else...)
*/
	priority_array.forEach(function(plugin_array) {
		if (plugin_array != undefined) {
			plugin_array.forEach(function(folder) {
				defer_loadList.push(self.loadCorePlugin(folder));
			});
		}
	});

	return libQ.all(defer_loadList);
};


PluginLoader.prototype.loadMyVolumioPlugins = function () {
    var self = this;
    var defer_loadList=[];
    var priority_array = new HashMap();

    var myVolumioPaths = ['/myvolumio/plugins','/data/myvolumio/plugins']

    for (var ppaths in myVolumioPaths) {
        var folder = myVolumioPaths[ppaths];
        self.logger.info('Loading plugins from folder ' + folder);

        if (fs.existsSync(folder)) {
            var pluginsFolder = fs.readdirSync(folder);
            for (var i in pluginsFolder) {
                var groupfolder = folder + '/' + pluginsFolder[i];

                var stats = fs.statSync(groupfolder);
                if (stats.isDirectory()) {

                    var folderContents = fs.readdirSync(groupfolder);
                    for (var j in folderContents) {
                        var subfolder = folderContents[j];

                        //loading plugin package.json
                        var pluginFolder = groupfolder + '/' + subfolder;

                        var package_json = self.pluginManager.getPackageJson(pluginFolder);
                        if(package_json!==undefined)
                        {
                            var boot_priority = package_json.volumio_info.boot_priority;
                            if (boot_priority == undefined)
                                boot_priority = 100;

                            var plugin_array = priority_array.get(boot_priority);
                            if (plugin_array == undefined)
                                plugin_array = [];

                            plugin_array.push(pluginFolder);
                            priority_array.set(boot_priority, plugin_array);
                            if (package_json.volumio_info.is_my_music_plugin) {
                                self.pluginManager.addMyMusicPlugin(package_json);
                            }
                        }

                    }
                }

            }
        }

    }

    /*
        each plugin's onVolumioStart() is launched by priority order.
        Note: there is no resolution strategy: each plugin completes
        at it's own pace, and in whatever order.
        Should completion order matter, a new promise strategy should be
        implemented below (chain by boot-priority order, or else...)
    */
    priority_array.forEach(function(plugin_array) {
        if (plugin_array != undefined) {
            plugin_array.forEach(function(folder) {
                defer_loadList.push(self.loadMyVolumioPlugin(folder));
            });
        }
    });

    return libQ.all(defer_loadList);
}

PluginLoader.prototype.loadMyVolumioPlugin = function (folder) {
    var self=this
    var defer=libQ.defer()
    var package_json = self.pluginManager.getPackageJson(folder);

    var category = package_json.volumio_info.plugin_type;
    var name = package_json.name;
    var key = category + '.' + name;

    self.logger.info('Loading plugin \"' + name + '\"...');

    var pluginInstance = null;
    var context=new (require(__dirname+'/pluginContext.js'))(self.pluginManager.coreCommand, self.pluginManager.websocketServer,self.pluginManager.configManager);
    context.setEnvVariable('category', category);
    context.setEnvVariable('name', name);

    try {
        pluginInstance = new (require(folder + '/' + package_json.main))(context);
        self.initializeConfiguration(package_json, pluginInstance, folder);
    } catch(e) {
        self.logger.error('!!!! WARNING !!!!');
        self.logger.error('The plugin ' + category + '/' + name + ' failed to load, setting it to stopped. Error: ' + e);
        self.logger.error('!!!! WARNING !!!!');
        self.pluginManager.coreCommand.pushToastMessage('error' , name + ' Plugin', self.pluginManager.coreCommand.getI18nString('PLUGINS.PLUGIN_START_ERROR'));
        self.pluginManager.config.set(category + '.' + name + '.status', "STOPPED");
    }

    var pluginData = {
        name: name,
        category: category,
        folder: folder,
        instance: pluginInstance
    };


    if (pluginInstance && pluginInstance.onVolumioStart !== undefined){
        var myPromise = pluginInstance.onVolumioStart();

        if (Object.prototype.toString.call(myPromise) != Object.prototype.toString.call(libQ.resolve())) {
            // Handle non-compliant onVolumioStart(): push an error message and disable plugin
            //self.coreCommand.pushToastMessage('error',name + " Plugin","This plugin has failing init routine. Please install updated version, or contact plugin developper");
            self.logger.error("ATTENTION!!!: Plugin " + name + " does not return adequate promise from onVolumioStart: please update!");
            myPromise = libQ.resolve();  // passing a fake promise to avoid crashes in new promise management
        }

        self.pluginManager.myVolumioPlugins.set(key, pluginData);  // set in any case, so it can be started/stopped

        defer.resolve();
    }
    else {
        self.pluginManager.myVolumioPlugins.set(key, pluginData);
        defer.resolve();
    }


    return defer
}

PluginLoader.prototype.startMyVolumioPlugins = function () {
    var self = this;
    var defer_startList=[];


    /*
        each plugin's onStart() is launched following plugins.json order.
        Note: there is no resolution strategy: each plugin completes
        at it's own pace, and in whatever order.
        Should completion order matter, a new promise strategy should be
        implemented below (chain by start order, or else...)
    */

    self.pluginManager.myVolumioPlugins.forEach(function (value,key) {
        defer_startList.push(self.startMyVolumioPlugin(value.category,value.name));
    });

    return libQ.all(defer_startList);
}

PluginLoader.prototype.startMyVolumioPlugin = function (category,name) {
    var self = this;
    var defer=libQ.defer();

    var plugin = self.pluginManager.getPlugin(category, name);

    if(plugin)
    {
        if(plugin.onStart!==undefined)
        {
            var myPromise = plugin.onStart();
            //self.config.set(category + '.' + name + '.status', "STARTED");

            if (Object.prototype.toString.call(myPromise) != Object.prototype.toString.call(libQ.resolve())) {
                // Handle non-compliant onStart(): push an error message and disable plugin
                //self.coreCommand.pushToastMessage('error',name + " Plugin","This plugin has failing start routine. Please install updated version, or contact plugin developper");
                self.logger.error("Plugin " + name + " does not return adequate promise from onStart: please update!");
                myPromise = libQ.resolve();  // passing a fake promise to avoid crashes in new promise management
            }

            defer.resolve();
            return myPromise;

        }
        else
        {
           // self.config.set(category + '.' + name + '.status', "STARTED");
            defer.resolve();
        }

    } else defer.resolve();

    return defer.promise;
}


PluginLoader.prototype.startMyVolumioPlugins = function () {
    var self = this;
    var defer_startList=[];

    self.pluginManager.myVolumioPlugins.forEach(function (value,key) {
        defer_startList.push(self.startMyVolumioPlugin(value.category,value.name));
    });

    return libQ.all(defer_startList);
};

PluginLoader.prototype.stopMyVolumioPlugins = function () {
    var self = this;
    var defer_stopList=[];

    self.pluginManager.myVolumioPlugins.forEach(function (value, key) {
        defer_stopList.push(self.pluginManager.stopMyVolumioPlugin(value.category,value.name));
    });

    return libQ.all(defer_stopList);
};


PluginLoader.prototype.startCorePlugin = function (category, name) {
	var self = this;
	var defer=libQ.defer();

	var plugin = self.pluginManager.getPlugin(category, name);

	if(plugin)
	{
		if(plugin.onStart!==undefined)
		{
		    var myPromise = plugin.onStart();
			self.pluginManager.config.set(category + '.' + name + '.status', "STARTED");

			if (Object.prototype.toString.call(myPromise) != Object.prototype.toString.call(libQ.resolve())) {
				// Handle non-compliant onStart(): push an error message and disable plugin
                self.pluginManager.coreCommand.pushToastMessage('error' , name + ' Plugin', self.pluginManager.coreCommand.getI18nString('PLUGINS.PLUGIN_START_ERROR'));
				self.pluginManager.logger.error("Plugin " + name + " does not return adequate promise from onStart: please update!");
				myPromise = libQ.resolve();  // passing a fake promise to avoid crashes in new promise management
			}

			defer.resolve();
			return myPromise;

		}
		else
		{
			self.pluginManager.config.set(category + '.' + name + '.status', "STARTED");
			defer.resolve();
		}

	} else defer.resolve();

	return defer.promise;
};

PluginLoader.prototype.startPlugin = function (category, name) {
    var self = this;
    var defer=libQ.defer();

    var plugin = self.pluginManager.getPlugin(category, name);

    if(plugin)
    {
        if(plugin.onStart!==undefined)
        {
            self.logger.info("PLUGIN START: "+name);
            var myPromise = plugin.onStart();
            self.pluginManager.config.set(category + '.' + name + '.status', "STARTED");

            if (Object.prototype.toString.call(myPromise) != Object.prototype.toString.call(libQ.resolve())) {
                // Handle non-compliant onStart(): push an error message and disable plugin
                self.pluginManager.coreCommand.pushToastMessage('error' , name + ' Plugin', self.pluginManager.coreCommand.getI18nString('PLUGINS.PLUGIN_START_ERROR'));
                self.logger.error("Plugin " + name + " does not return adequate promise from onStart: please update!");
                myPromise = libQ.resolve();  // passing a fake promise to avoid crashes in new promise management
            }

            defer.resolve();
            return myPromise;

        }
        else
        {
            self.pluginManager.config.set(category + '.' + name + '.status', "STARTED");
            defer.resolve();
        }

    } else defer.resolve();

    return defer.promise;
};

PluginLoader.prototype.stopPlugin = function (category, name) {
	var self = this;
	var defer=libQ.defer();

	var plugin = self.pluginManager.getPlugin(category, name);

	if(plugin)
	{
		if(plugin.onStop!==undefined)
		{
			var myPromise = plugin.onStop();
			self.pluginManager.config.set(category + '.' + name + '.status', "STOPPED");

			if (Object.prototype.toString.call(myPromise) != Object.prototype.toString.call(libQ.resolve())) {
				// Handle non-compliant onStop(): push an error message and disable plugin
                //self.coreCommand.pushToastMessage('error' , name + ' Plugin', self.coreCommand.getI18nString('PLUGINS.PLUGIN_START_ERROR'));
				self.logger.error("Plugin " + name + " does not return adequate promise from onStop: please update!");
				myPromise = libQ.resolve();  // passing a fake promise to avoid crashes in new promise management
			}

			defer.resolve();
			return myPromise;

		}
		else
		{
			self.pluginManager.config.set(category + '.' + name + '.status', "STOPPED");
			defer.resolve();
		}

	} else defer.resolve();

	return defer.promise;
};


PluginLoader.prototype.startCorePlugins = function () {
	var self = this;
	var defer_startList=[];

	self.logger.info("___________ START PLUGINS ___________");

/*
    each plugin's onStart() is launched following plugins.json order.
	Note: there is no resolution strategy: each plugin completes
	at it's own pace, and in whatever order.
	Should completion order matter, a new promise strategy should be
	implemented below (chain by start order, or else...)
*/

	self.pluginManager.corePlugins.forEach(function (value,key) {
		defer_startList.push(self.startCorePlugin(value.category,value.name));
	});

	return libQ.all(defer_startList);
};

PluginLoader.prototype.stopPlugins = function () {
	var self = this;
	var defer_stopList=[];

	self.logger.info("___________ STOP PLUGINS ___________");

/*
    each plugin's onStop() is launched following plugins.json order.
	Note: there is no resolution strategy: each plugin completes
	at it's own pace, and in whatever order.
	Should completion order matter, a new promise strategy should be
	implemented below (chain by start order, or else...)
*/

	self.pluginManager.corePlugins.forEach(function (value, key) {
		defer_stopList.push(self.pluginManager.stopPlugin(value.category,value.name));
	});

	return libQ.all(defer_stopList);
};


