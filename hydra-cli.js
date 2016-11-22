#!/usr/bin/env node
'use strict';

const fs = require('fs');
const rl = require('readline');
const Promise = require('bluebird');
const moment = require('moment');
const redis = require('redis');
const hydra = require('fwsp-hydra');
const Utils = require('fwsp-jsutils');
const config = require('fwsp-config');
const UMFMessage = require('fwsp-umf-message');
const version = require('./package.json').version;
const redisPreKey = 'hydra:service';

class Program {
  constructor() {
    this.configData = null;
    this.hydraConfig = null;
    this.redisdb = null;
  }

  /**
  * @name displayHelp
  * @description Display program help info
  */
  displayHelp() {
    console.log(`hydra-cli version ${version}`);
    console.log('Usage: hydra-cli command [parameters]');
    console.log('See docs at: https://github.com/flywheelsports/hydra-cli');
    console.log('');
    console.log('A command line interface for Hydra services');
    console.log('');
    console.log('Commands:');
    console.log('  help                        - this help list');
    console.log('  config                      - configure connection to redis');
    console.log('  config list                 - display current configuration');
    console.log('  message create              - create a message object');
    console.log('  message send message.json   - send a message');
    console.log('  nodes                       - same as nodes lists');
    console.log('  nodes list [serviceName]    - display service instance nodes');
    console.log('  nodes remove id             - remove a service from nodes list');
    console.log('  rest path [payload.json]    - make an HTTP RESTful call to a service');
    console.log('  routes [serviceName]        - display service API routes');
    console.log('  healthlog serviceName       - display service health log');
    console.log('');
  }

  /**
  * @name getUserHome
  * @description Retrieve user's home directory
  * @return {string} - user's home directory path
  */
  getUserHome() {
    return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
  }

  /**
  * @name main
  * @description entry point for command dispatch processing
  */
  main() {
    if (process.argv.length < 3) {
      this.displayHelp();
      process.exit();
      return;
    }

    this.hydraConfig = `${this.getUserHome()}/.hydra-cli`;
    fs.readFile(this.hydraConfig, 'utf8', (err, data) => {
      if (!err) {
        try {
          this.configData = JSON.parse(data);
          let conf = {
            'serviceName': 'hydra-cli',
            'serviceDescription': 'Not a service',
            'serviceIP': '',
            'servicePort': 0,
            'serviceType': 'non',
            'redis': {
              'url': this.configData.redisUrl,
              'port': this.configData.redisPort,
              'db': this.configData.redisDb
            }
          };
          hydra.init(conf);
        } catch (e) {
          this.configData = null;
        }
      }

      let command = process.argv[2];
      let args = process.argv.slice(3);

      switch (command) {
        case 'config':
          this.handleConfigCommand(args);
          break;
        case 'help':
          this.displayHelp();
          process.exit();
          break;
        case 'message':
          switch (args[0]) {
            case 'create':
              this.handleMessageCreate(args);
              break;
            case 'send':
              this.handleMessageSend(args);
              break;
            default:
              console.log(`Unknown message options: ${args[0]}`);
              this.exitApp();
              break;
          }
          break;
        case 'nodes':
          switch (args[0]) {
            case 'list':
              this.handleNodesList(args);
              break;
            case 'remove':
              this.handleNodesRemove(args);
              break;
            default:
              if (args.length === 0) {
                this.handleNodesList(args);
              } else {
                console.log(`Unknown nodes options: ${args[0]}`);
                this.exitApp();
              }
              break;
          }
          break;
        case 'rest':
          this.handleRest(args);
          break;
        case 'routes':
          this.handleRoutes(args);
          break;
        case 'healthlog':
          this.handleHealthLog(args);
          break;
        default:
          console.log(`Unknown command: ${command}`);
          this.exitApp();
          break;
      }
    });
  }

  /**
  * @name redisConnect
  * @description Connect to an instance of redis. This is the redis db that Hydra is using
  * @return {object} promise - promise resolving
  */
  redisConnect() {
    return new Promise((resolve, reject) => {
      let redisdb = redis.createClient(this.configData.redisPort, this.configData.redisUrl);
      redisdb.select(this.configData.redisDb, (err, result) => {
        this.redisdb = redisdb;
        resolve();
      });
    });
  }

  /**
  * @name exitApp
  * @description properly exit this app
  */
  exitApp() {
    setTimeout(() => {
      hydra.shutdown();
      if (this.redisdb) {
        this.redisdb.quit();
      }
      console.log(' ');
      process.exit();
    }, 250);
  }

  /**
  * @name getKeys
  * @summary Retrieves a list of redis keys based on pattern.
  * @param {string} pattern - pattern to filter with
  * @return {object} promise - promise resolving to array of keys or or empty array
  */
  getKeys(pattern) {
    return new Promise((resolve, reject) => {
      this.redisdb.keys(pattern, (err, result) => {
        if (err) {
          resolve([]);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
  * @name getRoutes
  * @summary Retrieves a array list of routes
  * @param {string} serviceName - name of service to retreieve list of routes.
  *                 If param is undefined, then the current serviceName is used.
  * @return {object} Promise - resolving to array of routes or rejection
  */
  getRoutes(serviceName) {
    return new Promise((resolve, reject) => {
      let routesKey = `${redisPreKey}:${serviceName}:service:routes`;
      this.redisdb.smembers(routesKey, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
  * @name displayJSON
  * @description pretty print json
  * @param {string} json - stringified json
  */
  displayJSON(json) {
    if (typeof json === 'string') {
      let js = Utils.safeJSONParse(json);
      if (!js) {
        console.log(json);
      } else {
        console.log(JSON.stringify(js, null, 2));
      }
    } else {
      console.log(JSON.stringify(json, null, 2));
    }
  }

  /* ************************************************************************* */
  /* ************************************************************************* */
  /* ************************************************************************* */
  /* ************************************************************************* */

  /**
  * @name handleConfigCommand
  * @description handle the creation of the app config DOT file.
  * @param {array} args - program arguments
  */
  handleConfigCommand(args) {
    if (args.length === 1 && args[0] === 'list')  {
      console.log(JSON.stringify(this.configData, null, 2));
      process.exit();
      return;
    }
    let prompts = rl.createInterface(process.stdin, process.stdout);
    prompts.question('redisUrl: ', (redisUrl) => {
      prompts.question('redisPort: ', (redisPort) => {
        prompts.question('redisDb: ', (redisDb) => {
          let data = this.configData || {};
          data.redisUrl = redisUrl;
          data.redisPort = redisPort;
          data.redisDb = redisDb;
          fs.writeFile(this.hydraConfig, JSON.stringify(data), (err) => {
            if (err) {
              console.log(err);
            }
            process.exit();
          });
        });
      });
    });
  }

  /**
  * @name handleHealthLog
  * @description display service health log
  * @param {array} args - program arguments
  */
  handleHealthLog(args) {
    this.redisConnect()
      .then(() => {
        this.getKeys(`*:${args[0]}:*:health:log`)
          .then((instances) => {
            if (instances.length === 0) {
              console.log('[]');
              this.exitApp();
              return;
            }
            let trans = this.redisdb.multi();
            instances.forEach((instance) => {
              trans.lrange(instance, 0, 100);
            });
            trans.exec((err, result) => {
              if (err) {
                console.log(err);
              } else {
                let response = [];
                if (result || result.length > 0) {
                  result = result[0];
                  result.forEach((entry) => {
                    response.push(Utils.safeJSONParse(entry));
                  });
                }
                console.log(JSON.stringify(response, null, 2));
              }
              this.exitApp();
            });
          });
      });
  }

  /**
  * @name handleMessageCreate
  * @description Display a new message
  * @param {array} args - program arguments
  */
  handleMessageCreate(args) {
    let msg = UMFMessage.createMessage({
      to: '{serviceName here}:/',
      from: 'hydra-cli:/',
      body: {}
    });
    this.displayJSON(msg);
    this.exitApp();
  }

  /**
  * @name handleMessageSend
  * @description Send message
  * @param {array} args - program arguments
  */
  handleMessageSend(args) {
    if (args.length !== 2) {
      console.log('Invalid number of parameters');
      this.exitApp();
      return;
    }
    config.init(args[1])
      .then(() => {
        hydra.sendMessage(config.getObject());
        this.exitApp();
        return null;
      })
      .catch((err) => {
        console.log(err.message);
        this.exitApp();
      });
  }

  /**
  * @name handleNodesList
  * @description handle the display of service nodes.
  * @param {array} args - program arguments
  */
  handleNodesList(args) {
    this.redisConnect()
      .then(() => {
        let now = moment.now();
        this.redisdb.hgetall(`${redisPreKey}:nodes`, (err, data) => {
          if (err) {
            console.log(err);
          } else {
            if (data !== null) {
              let nodes = [];
              Object.keys(data).forEach((entry) => {
                let item = Utils.safeJSONParse(data[entry]);
                if ((args.length === 0 || args.length === 1) || (args.length === 2 && item.serviceName.indexOf(args[1]) > -1)) {
                  item.elapsed = parseInt(moment.duration(now - moment(item.updatedOn)) / 1000);
                  nodes.push(item);
                }
              });
              console.log(JSON.stringify(nodes, null, 2));
            }
          }
          this.exitApp();
        });
      });
  }

  /**
  * @name handleNodesRemove
  * @description handle the removal of service node data.
  * @param {array} args - program arguments
  */
  handleNodesRemove(args) {
    if (args.length !== 2) {
      console.log('Missing parameter id');
      this.exitApp();
    }
    this.redisConnect()
      .then(() => {
        this.redisdb.hdel(`${redisPreKey}:nodes`, args[1], (err, data) => {
          if (err) {
            console.log(err);
          } else {
            console.log(`nodes entry ${args[1]} removed`);
          }
          this.exitApp();
        });
      });
  }

  /**
  * @name handleRest
  * @description handle RESTful calls
  * @param {array} args - program arguments
  * @return {undefined}
  */
  handleRest(args) {
    let route = UMFMessage.parseRoute(args[0]);
    if (route.error) {
      console.log(`${route.error}`);
      this.exitApp();
      return;
    }

    let method = route.httpMethod || 'get';
    if ((method === 'get' || method === 'delete') && args.length > 1) {
      console.log(`Payload not allowed for HTTP '${method}' method`);
      this.exitApp();
      return;
    }

    if (args.length > 1) {
      config.init(args[1])
        .then(() => {
          let msg = UMFMessage.createMessage({
            to: `${args[0]}`,
            from: 'hydra-cli:/',
            body: config.getObject() || {}
          });
          hydra.makeAPIRequest(msg)
            .then((res) => {
              this.displayJSON(res);
              this.exitApp();
            })
            .catch((err) => {
              console.log('err', err);
              this.exitApp();
            });
          return null;
        })
        .catch((err) => {
          console.log(`Unable to open ${args[1]}`);
          this.exitApp();
        });
    } else {
      let msg = UMFMessage.createMessage({
        to: `${args[0]}`,
        from: 'hydra-cli:/',
        body: {}
      });
      hydra.makeAPIRequest(msg)
        .then((res) => {
          this.displayJSON(res);
          this.exitApp();
        })
        .catch((err) => {
          console.log('err', err);
          this.exitApp();
        });
      return null;
    }
  }

  /**
  * @name handleRoutes
  * @description handle the display of service routes
  * @param {array} args - program arguments
  */
  handleRoutes(args) {
    this.redisConnect()
      .then(() => {
        let promises = [];
        let serviceNames = [];
        this.getKeys('*:routes')
          .then((serviceRoutes) => {
            serviceRoutes.forEach((service) => {
              let segments = service.split(':');
              let serviceName = segments[2];
              if (args.length === 0 || (args.length === 1 && serviceName.indexOf(args[0]) > -1)) {
                serviceNames.push(serviceName);
                promises.push(this.getRoutes(serviceName));
              }
            });
            return Promise.all(promises);
          })
          .then((routes) => {
            let resObj = {};
            let idx = 0;
            routes.forEach((routesList) => {
              resObj[serviceNames[idx]] = routesList;
              idx += 1;
            });
            console.log(JSON.stringify(resObj, null, 2));
            this.exitApp();
          })
          .catch((err) => {
            console.log(err);
            this.exitApp();
          });
      });
  }
}

new Program().main();
