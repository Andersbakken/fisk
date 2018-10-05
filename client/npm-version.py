#!/usr/bin/env python

import json
import os
import sys

with open(os.path.realpath(os.path.dirname(__file__)) + '/../package.json') as f:
    data = json.load(f)
    print data["version"];
