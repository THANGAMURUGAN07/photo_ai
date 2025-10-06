#!/bin/bash
# Exit on error
set -e

# Install Python 3.10
pyenv install -s 3.10.13
pyenv global 3.10.13

# Verify Python version
python --version

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt
