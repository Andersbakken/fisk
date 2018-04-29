const environments = {
    _environs: [],

    load: function load(cb) {
        return new Promise((resolve, reject) => {
            resolve();
        });
    },

    prepare: function(environ) {
    },

    save: function save(data) {
        return new Promise((resolve, reject) => {
            resolve();
        });
    },

    complete: function() {
    },

    get environments() {
        return environments._environs;
    }
};

module.exports = environments;
