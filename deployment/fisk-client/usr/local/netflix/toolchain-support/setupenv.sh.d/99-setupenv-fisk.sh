#!/usr/bin/env bash

if [ "$FISK_DISABLED" = "1" ] || [ -n "$FISKED" ]; then
    if [ "$FISKED" ]; then
        setupenv_verbose "Compiler already fisked"
    else
        setupenv_verbose "Fisk is disabled"
    fi

    return 0
fi

# Split the compiler string in two, in case we have ARCH_FLAGS
ORIGINAL_CC_NAME="$(echo $ORIGINAL_CC | cut -f1 -d' ')"
ORIGINAL_CFLAGS="$(echo $ORIGINAL_CC | cut -s -f2- -d' ')"
CC_MD5=$(echo $ORIGINAL_CFLAGS | md5sum | cut -f1 -d' ')
ORIGINAL_CXX_NAME="$(echo $ORIGINAL_CXX | cut -f1 -d' ')"
ORIGINAL_CXXFLAGS="$(echo $ORIGINAL_CXX | cut -s -f2- -d' ')"
CXX_MD5=$(echo $ORIGINAL_CXXFLAGS | md5sum | cut -f1 -d' ')

BASECC=`basename $(echo $ORIGINAL_CC_NAME | cut -f1 -d' ')`
BASECXX=`basename $(echo $ORIGINAL_CXX_NAME | cut -f1 -d' ')`
VERSION=`ORIGINAL_CXX -dumpversion 2>/dev/null`
if [ -n "$VERSION" ]; then
    VERSION="-$VERSION"
fi

setupenv_verbose "Enabling fisk and disabling ccache"

SCRIPT_PATH_CC="/var/fisk/client/compilers/$(dirname $ORIGINAL_CC_NAME)/${CC_MD5}/$BASECC"
SCRIPT_PATH_CXX="/var/fisk/client/compilers/$(dirname $ORIGINAL_CXX_NAME)/${CXX_MD5}/$BASECXX"

mkdir -p `dirname $SCRIPT_PATH_CC`
mkdir -p `dirname $SCRIPT_PATH_CXX`

if [ ! -e "$SCRIPT_PATH_CC" ]; then
    echo -e "#!/usr/bin/env bash\nfiskc --fisk-compiler=$ORIGINAL_CC_NAME $ORIGINAL_CFLAGS \${1+\"\$@\"}" > $SCRIPT_PATH_CC
    chmod +x $SCRIPT_PATH_CC
fi

CFLAGS="$ORIGINAL_CFLAGS $CFLAGS"

if [ ! -e "$SCRIPT_PATH_CXX" ]; then
    echo -e "#!/usr/bin/env bash\nfiskc --fisk-compiler=$ORIGINAL_CXX_NAME $ORIGINAL_CXXFLAGS \${1+\"\$@\"}" > $SCRIPT_PATH_CXX
    chmod +x $SCRIPT_PATH_CXX
fi

CXXFLAGS="$ORIGINAL_CXXFLAGS $CXXFLAGS"

export CC="$SCRIPT_PATH_CC"
export CXX="$SCRIPT_PATH_CXX"

setupenv_debug "CC: ${CC}"
setupenv_debug "CXX: ${CXX}"

if [ -x "`which ccache`" ] && [ "$FISK_FORCE_CCACHE" = "1" ]; then
    setupenv_verbose "Enabling fisk and ccache"
    CC="`which ccache` $CC"
    CXX="`which ccache` $CXX"
    setupenv_debug "CC: ${CC}"
    setupenv_debug "CXX: ${CXX}"
fi
