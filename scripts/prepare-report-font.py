"""Build the bundled regular-weight report font from Google's Noto Sans SC variable TTF.

Authoring tool only (pip install fonttools); not required to run the application.
Usage: python scripts/prepare-report-font.py input-variable.ttf output-static.ttf
Original: https://github.com/google/fonts/tree/main/ofl/notosanssc
"""
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

font = instantiateVariableFont(TTFont(sys.argv[1]), {"wght": 400}, inplace=True)
names = {1: "VulnAgent Report Sans", 2: "Regular", 3: "VulnAgentReportSans-Regular-1", 4: "VulnAgent Report Sans Regular", 6: "VulnAgentReportSans-Regular", 16: "VulnAgent Report Sans", 17: "Regular"}
for record in list(font["name"].names):
    if record.nameID in names:
        font["name"].setName(names[record.nameID], record.nameID, record.platformID, record.platEncID, record.langID)
font.save(sys.argv[2])
