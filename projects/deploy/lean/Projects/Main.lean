import Projects.Spec

open Inframe

def main : IO Unit :=
  emitGraph (Projects.projects Projects.bitcrush)
