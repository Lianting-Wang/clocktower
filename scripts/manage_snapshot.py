#!/usr/bin/env python3
"""Pass the same refresh/offline options to both reproducible snapshots."""
from pathlib import Path
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
for script in ('snapshot.py', 'content_snapshot.py'):
    subprocess.run([sys.executable, str(root / 'scripts' / script), *sys.argv[1:]], check=True)
