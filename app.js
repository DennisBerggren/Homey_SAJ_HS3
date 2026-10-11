'use strict';

const Homey = require('homey');

class SajHs3App extends Homey.App {

  async onInit() {
    this.log('SAJ HS3 Control startad');
  }

}

module.exports = SajHs3App;
