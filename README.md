# fisk
Fisk, a nice distributed compile system

If you get:

  Could NOT find OpenSSL, try to set the path to OpenSSL root folder in the

On mac.

Install openssl with brew and do:

OPENSSL_ROOT_DIR=/usr/local//Cellar/openssl/1.0.2o_1/ cmake ...
