---
title: "Sections"
# The rows of the landing page. They are content, not pages: each one is
# rendered into the home template and never published on its own URL.
cascade:
  # Landing content: shares the landing type so it also shares the landing
  # Markdown render hooks instead of Hextra's.
  type: "landing"
  params:
    llms: false
  build:
    render: never
    list: local
---
