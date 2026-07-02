/*
* These methods are included on every page
*/

// Console-polyfill. MIT license.
// https://github.com/paulmillr/console-polyfill
// Make it safe to do console.log() always.
(function(global) {
  'use strict';
  if (!global.console) {
    global.console = {};
  }
  var con = global.console;
  var prop, method;
  var dummy = function() {};
  var properties = ['memory'];
  var methods = ('assert,clear,count,debug,dir,dirxml,error,exception,group,' +
     'groupCollapsed,groupEnd,info,log,markTimeline,profile,profiles,profileEnd,' +
     'show,table,time,timeEnd,timeline,timelineEnd,timeStamp,trace,warn').split(',');
  while (prop = properties.pop()) if (!con[prop]) con[prop] = {};
  while (method = methods.pop()) if (!con[method]) con[method] = dummy;
  // Using `this` for web workers & supports Browserify / Webpack.
})(typeof window === 'undefined' ? this : window);


// ServerTimeService is used for getting time synchronized with server by #serverTimestamp element in header.php
function ServerTimeService() {
    var self = this;
    var serverSyncFrequency = 120000;
    this.timeNow = Date.now();

    window.addEventListener('focus', function () {
        self.syncTimeWithServer();
    });

    this.startClock = function () {
        if (window.Worker) {
            var worker = new Worker('/js/script/lib/custom/timers_web_worker.js');

            worker.addEventListener('message', function (e) {
                if (e.data === 'tick') {
                    self.timeNow += 1000;
                }
            });

            worker.postMessage('run the timer');
        } else {
            setInterval(function () {
                self.timeNow += 1000;
            }, 1000);
        }
    };

    this.syncTimeWithServer = function() {
        if (typeof (getAction) === "function" && getCookie('isLoggedIn') === '1') {
            var start = Date.now();
            var action = '/sidebarAjaxAction.php?action=servertime&t=' + start;
            getAction({
                type: "get",
                action,
                success: function (resp) {

                    try {
                        var data = JSON.parse(resp);
                        var latency = (Date.now() - start) / 2;

                        self.timeNow = data && data.time + latency;
                    } catch(e) {
                        console.error('Some error happen during JSON parsing: ', resp);
                    }
                }
            });
        }
    };

    self.syncTimeWithServer();

    setInterval(function() {
        if (document.hidden === false) {
            self.syncTimeWithServer()
        }
    }, serverSyncFrequency)
}

var serverTimeService = new ServerTimeService();
serverTimeService.startClock();

function getCurrentTimestamp() {
    return serverTimeService.timeNow;
}

function getCurrentTime() {
    return new Date(getCurrentTimestamp());
}

function getCookie(name) {
    var r = document.cookie.match("\\b" + name + "=([^;]*)\\b");
    return r ? r[1] : undefined;
}

jQuery.extend({
  getUrlVars: function(){
    var vars = [], hash;
    var hashes = window.location.href.slice(window.location.href.indexOf('?') + 1).split('&');
    for(var i = 0; i < hashes.length; i++)
    {
      hash = hashes[i].split('=');
      vars.push(hash[0]);
      vars[hash[0]] = hash[1];
    }
    return vars;
  },
  getUrlVar: function(name){
    return jQuery.getUrlVars()[name];
  }
});


function dump(arr,level) {
	var dumped_text = "";
	if(!level) level = 0;

	//The padding given at the beginning of the line.
	var level_padding = "";
	for(var j=0;j<level+1;j++) level_padding += "    ";

	if(typeof(arr) == 'object') { //Array/Hashes/Objects
		for(var item in arr) {
			var value = arr[item];

			if(typeof(value) == 'object') { //If it is an array,
				dumped_text += level_padding + "'" + item + "' ...\n";
				dumped_text += dump(value,level+1);
			} else {
				dumped_text += level_padding + "'" + item + "' => \"" + value + "\"\n";
			}
		}
	} else { //Stings/Chars/Numbers etc.
		dumped_text = "===>"+arr+"<===("+typeof(arr)+")";
	}
	return dumped_text;
}

function countdownsTickCallback() {
    var $el = $(this),
        stepPercentage = parseInt($el.attr('data-until')) / parseInt($el.attr('data-timestep')),
        newUntil = parseInt($el.attr('data-until')) - parseInt($el.countdown('option', 'tickInterval')),
        newFillTimeLeft = parseInt($el.attr('data-filltimeleft')) - parseInt($el.countdown('option', 'tickInterval')),
        $parent = $el.closest('.energy-info'),
        $progressLineTimer = $el.closest('.energy-info').find('.progress-line-timer'),
        progressWidth = 0,
        counter = 1,
        filltimeleft = parseInt($el.attr('data-filltimeleft'));

    progressWidth = $parent.hasClass('chain-wrap') ? Math.round(stepPercentage*100) : (100 - Math.round(stepPercentage*100));

    $progressLineTimer.css('width', progressWidth + "%");
    $el.attr('data-until', newUntil);
    $el.attr('data-filltimeleft', newFillTimeLeft);
}

function checkClientAndServerTime(selector) {
    var $el = selector;
    var fillTimeLeft = parseInt($el.attr('data-filltimeleft'));
    var fillTimeLeftHours = Math.floor(fillTimeLeft)/3600;
    var serverTime = parseInt($el.attr('data-stime'));
    var clientTime = Math.floor($.now()/1000);

    var sHours = new Date(serverTime).getHours();
    var cHours = new Date(clientTime).getHours();

    var difference = sHours - cHours;

    if (difference != 0 && (fillTimeLeftHours > 0 || difference > 0)) {
        $el.attr('data-filltimeleft', fillTimeLeftHours + difference);
    }
}

function startCountdowns() {

    var refreshingEnergy = false;

    jQuery(".countdown").each(function () {
        var e = jQuery(this);
        checkClientAndServerTime(e);
        if (!isNaN(+e.data("until"))) {
            var options = {
                until: +e.data("until"),
                layout: e.data("layout"),
                onTick: countdownsTickCallback
            };
            if (e.data("on-expiry") == "refreshenergy")
                options.onExpiry = function () {
                    if (refreshingEnergy) {
                        return;
                    }

                    refreshingEnergy = true;

                    var statBars = {};
                    setStatBarsCookie();
                    $('.menu-list .energy-info').each(function() {
                        var $elem = $(this);
                        statBars[$elem.attr('id')] = parseInt($elem.find('.count').attr('data-current'));
                    });
                    setStatBarsCookie(statBars);
                  
                    ajaxWrapper({
                        type: "POST",
                        url: location.protocol + "//" + location.hostname + "/refreshenergy.php",
                        timeout: 10 * 1000,
                        onsuccess: function (data) {
                            jQuery("#player-stats").html(jQuery(data).html());
                            startCountdowns();
                            checkProgressOverfull();
                            //tooltip();
                            initializeTooltip('.menu-info .icons', 'white-tooltip');
                            window.sidebarIconsLiveTime = 0;
                            refreshingEnergy = false;
                        },
                        onerror: function () {
                            refreshingEnergy = false;
                        }
                    });
                };

            e.countdown(options);
        }
    });
}

jQuery(document).ready(function () {
    startCountdowns();
    setTimeout(function () {
        serverTimeService.syncTimeWithServer();
    }, 20000);
});
