'use strict';

const AnyProxy = require('anyproxy');
const mime = require('mime');
const micromatch = require('micromatch');
const path = require('path');
const url = require('url');

let bone, fs;

/**
usage: 

search: String, String(glob), RegExp
target: String(local), String(http), Object(json data)

{
    map: {
        'link': {
            search: 'http://www.xx.com/index.js',
            target: 'http://www.xx.com/map/index.js'
        },
        'regexp': {
            search: /^http\:\/\/www\.xx\.com\/(index\.js)/,
            target: '/local/path/{$1}'
        },
        'glob': {
            search: 'http://www.xx.com/*',
            target: '~/local/path/{$1}'
        },
        'api': {
            search: 'http://www.xx.com/api',
            target: 'http://www.xx.com/map/api'
        },
        'data': {
            search: 'http://www.xx.com/data.json',
            target: {
                json: true
            }
        }
    },
    hosts: {
        'www.xx.com': '127.0.0.1'
    }
}
*/

function generateHeaders (filePath) {
    return {
        'Cache-Control': 'max-age=0, must-revalidate',
        'Content-Type': mime.getType(filePath)
    };
}

function map (requestDetail, mapRule) {
    return new Promise(function (resolve, reject) {
        var target = mapRule.target;
        var result;

        if (mapRule.type == 'regexp') {
            result = mapRule.regexp.match(requestDetail.url);
        }

        if (mapRule.type == 'glob') {
            result = micromatch.capture(mapRule.search, requestDetail.url);
        }

        let targetUriDealList = [];
        for (let i = 0; i < target.length; i++) {
            let targetItem = target[i];
            let targetUri = targetItem.value;

            switch (targetItem.type) {
                case 'data':
                    return resolve({
                        response: {
                            statusCode: 200,
                            header: generateHeaders('data.json'),
                            body: JSON.stringify(targetUri)
                        }
                    });
                break;

                case 'api':
                case 'file':
                    result.forEach(function (match, idx) {
                        targetUri = targetUri.replace(new RegExp('\\{\\$' + idx + '\\}', 'g'), match);
                    });

                    targetUriDealList.push(targetUri);

                    if (targetItem.type === 'api') {
                        Object.assign(requestDetail.requestOptions, url.parse(targetUri));

                        requestDetail.requestOptions.headers.Host = requestDetail.requestOptions.host;
                        requestDetail.protocol = requestDetail.requestOptions.protocol.replace(':', '');

                        return resolve(requestDetail);
                    } else {
                        targetUri = targetUri.split('?')[0];
                        targetUri = path.normalize(targetUri);

                        if (fs.existFile(targetUri)) {
                            fs.readFile(targetUri, function (error, body) {
                                resolve({
                                    response: {
                                        statusCode: 200,
                                        header: generateHeaders(targetUri),
                                        body
                                    }
                                })
                            });
                            return;
                        }
                    }
                break;
            }
        }

        throw new Error(`unable to deal ${requestDetail.url} with ${targetUriDealList}`);
    });
}

function dealWithRule (customRule) {
    for (let key in customRule.map) {
        let mapRule = customRule.map[key];
        let { search, target } = mapRule;

        if (search instanceof RegExp) {
            mapRule.regexp = search;
            mapRule.type = 'regexp';
        }

        if (typeof search === 'string') {
            mapRule.regexp = micromatch.makeRe(search);
            mapRule.type = 'glob';
        }

        if (!mapRule.regexp) {
            throw new Error(`unsupport rule search: "${search}"`);
        }

        if (!Array.isArray(target)) {
            target = [target];
        }

        mapRule.target = target.map(function (tg) {
            let type;

            if (typeof tg === 'string') {
                if (tg.indexOf('http') === 0) {
                    type = 'api';
                } else {
                    type = 'file';
                }
            }

            if (typeof tg === 'object') {
                type = 'data';
            }

            if (!type) {
                throw new Error(`unsupport rule target: "${target}"`);
            }

            return {
                value: tg,
                type
            };
        });

    }

    return customRule;
}

function setBone (b, f) {
    bone = b;
    fs = f;
}

module.exports = function (conf) {
    return function(command, bone, fs) {
        var pkg = require('./package.json');
        var customRule = {
            map: {},
            hosts: {}
        };

        setBone(bone, fs);

        const rule = {
            summary: 'bone anyproxy plugins',
            *beforeSendRequest (requestDetail) {
                return Promise.resolve(requestDetail)
                .then(function (requestDetail) {
                    var { requestOptions, protocol, url, requestData } = requestDetail;

                    // map feature
                    for (let key in customRule.map) {
                        let mapRule = customRule.map[key];

                        if (mapRule.regexp.test(url)) {
                            return map(requestDetail, mapRule);
                        }
                    }

                    // hosts feature
                    if (customRule.hosts[requestOptions.hostname]) {
                        requestOptions.hostname = customRule.hosts[requestOptions.hostname];
                    }

                    return requestDetail;
                });
            }
        };

        const options = {
            port: 8001,
            rule: rule,
            webInterface: {
                enable: false,
                webPort: 8002,
                wsPort: 8003
            },
            throttle: 10000,
            forceProxyHttps: false,
            silent: false
        };

        /*
        {
            port: '',
            throttle: '',
            silent: '',
            web: '',
            ws: ''
        }
        */
        command('anyproxy')
            .version(pkg.version)
            .option('-p, --port [value]', 'proxy port, 8001 for default')
            .option('-w, --web [value]', 'web GUI port, 8002 for default')
            .option('-s, --silent', 'do not print anything into terminal')
            .option('-c, --clear', 'clear all the certificates and temp files')
            .action(function(argv) {
                Object.assign(customRule, conf.rule);
                customRule = dealWithRule(customRule);

                delete conf.rule;
                
                const opts = Object.assign({}, conf, argv);

                if (!Object.is(opts.port, undefined)) {
                    options.port = opts.port;
                }

                if (!Object.is(opts.throttle, undefined)) {
                    options.throttle = opts.throttle;
                }

                if (!Object.is(opts.silent, undefined)) {
                    options.silent = opts.silent;
                }

                if (!Object.is(opts.web, undefined)) {
                    options.webInterface.enable = true;
                    options.webInterface.webPort = opts.web;
                    if (!Object.is(opts.ws, undefined)) {
                        options.wsPort = opts.ws;
                    }
                }

                bone.watch();

                const proxyServer = new AnyProxy.ProxyServer(options);

                proxyServer.start();
            });
    }
};