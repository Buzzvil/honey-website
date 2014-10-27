var aws = require("aws-sdk");
var crypto = require("crypto");
var del = require("del");
var express = require("express");
var fs = require("fs");
var gulp = require("gulp");
var hl = require("highland");
var jade = require("gulp-jade");
var less = require("gulp-less");
var path = require("path");
var zlib = require("zlib");

aws.config.update({
    region: "ap-northeast-1"
});

var GZcall = hl.wrapCallback(zlib.gzip.bind(zlib));

var S3call = hl.wrapCallback(function (opts, next) {
    new aws.S3().putObject(opts, next);
});

var CFcall = hl.wrapCallback(function (opts, next) {
    new aws.CloudFront().createInvalidation(opts, next);
});

var l10nObj = {};
var fileObj = {};

var l10nAll = function (next) {
    hl(Object.keys(l10nObj))
        .map(this)
        .map(function (val) {
            return hl(val).errors(hl.log);
        })
        .merge()
        .once("end", next)
        .resume();
};

gulp.task("clean", function (next) {
    del("dist", next);
});

gulp.task("i18n", function () {
    (process.env.L10N || "en,ja,ko,zh-tw").split(",").forEach(function (key) {
        l10nObj[key] = JSON.parse(fs.readFileSync("l10n/" + key + ".json", "utf8"));
    });
});

gulp.task("styles", ["clean", "i18n"], l10nAll.bind(function (l10n) {
    var opts = {
        compress: true,
        globalVars: {
            i: JSON.stringify("/i/"),
            I: JSON.stringify("/i/" + l10n + "/")
        }
    };
    
    return gulp.src("page/*.less")
        .pipe(less(opts))
        .pipe(hl())
        .doto(function (file) {
            var type = path.extname(file.path);
            var name = path.basename(file.path, type);
            var hash = crypto
                .createHash("md5")
                .update(file.contents)
                .digest("hex")
                .slice(0, 12);
            
            file.path = path.dirname(file.path) + "/" + name + "-" + hash + type;
            fileObj[name + type.slice(1)] = "/" + file.relative;
        })
        .pipe(gulp.dest("dist/" + l10n));
}));

gulp.task("pages", ["styles"], l10nAll.bind(function (l10n) {
    var opts = {
        locals: l10nObj[l10n]
    };
    
    opts.locals.i = "/i/";
    opts.locals.I = "/i/" + l10n + "/";
    opts.locals.files = fileObj;
    opts.locals.gakey = process.env.GANALYTICS_KEY;
    
    return gulp.src("page/!(global).jade")
        .pipe(jade(opts))
        .pipe(hl())
        .doto(function (file) {
            file.path = file.path.slice(0, -5);
        })
        .pipe(gulp.dest("dist/" + l10n));
}));

gulp.task("upload", ["pages"], l10nAll.bind(function (l10n) {
    var list = gulp.src("dist/" + l10n + "/*").pipe(hl());
    
    var cc = {
        "": "no-cache",
        ".css": "public, max-age=2592000"
    };
    
    var ct = {
        "": "text/html; charset=UTF-8",
        ".css": "text/css; charset=UTF-8"
    };
    
    return list
        .fork()
        .pluck("contents")
        .flatMap(GZcall)
        .zip(list.fork())
        .flatMap(function (zip) {
            var type = path.extname(zip[1].path);
            
            return S3call({
                Bucket: l10nObj[l10n].meta.bucket,
                Key: zip[1].relative,
                Body: zip[0],
                CacheControl: cc[type],
                ContentEncoding: "gzip",
                ContentLanguage: l10nObj[l10n].meta.code,
                ContentType: ct[type]
            });
        });
}));

gulp.task("publish", ["upload"], l10nAll.bind(function (l10n) {
    return gulp.src("dist/" + l10n + "/!(*.*)")
        .pipe(hl())
        .collect()
        .flatMap(function (arr) {
            arr = arr.map(function (val) {
                return "/" + val.relative;
            });
            
            return CFcall({
                DistributionId: l10nObj[l10n].meta.cloudkey,
                InvalidationBatch: {
                    CallerReference: "gulp" + Date.now(),
                    Paths: {
                        Quantity: arr.length,
                        Items: arr
                    }
                }
            });
        });
}));

gulp.task("watch", function () {
    gulp.watch(["page/*.*", "l10n/*.json"], ["pages"]);
    
    express()
        .use(express.static("dist/" + process.env.L10N, {
            index: "index",
            setHeaders: function (res, file) {
                if (!path.extname(file)) {
                    res.type("html");
                }
            }
        }))
        .use("/i", express.static("../honeyscreen-website-media"))
        .listen(9100);
});

gulp.task("default", ["pages"]);