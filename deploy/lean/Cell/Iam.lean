import Inframe

/-!
IAM policy documents as data. Statements are Lean values, so the stack's tests can prove what a
principal may do (`Cell.Test`), and they render to the JSON IAM expects. Every string a statement
carries is an action, an ARN, an id or a condition value: none needs JSON escaping.
-/

open Inframe

namespace Cell.Iam

/-- One condition operator with its keys, e.g. `StringEquals` → `aws:ResourceTag/nest` = `["true"]`. -/
structure Condition where
  op : String
  entries : List (String × List (Input String))

structure Statement where
  sid : String
  actions : List String
  resources : List (Input String)
  conditions : List Condition := []

private def quote (value : Input String) : Input String := "\"" ++ value ++ "\""

private def joinWith (separator : String) : List (Input String) → Input String
  | [] => ""
  | [x] => x
  | x :: rest => x ++ separator ++ joinWith separator rest

private def stringArray (values : List (Input String)) : Input String :=
  "[" ++ joinWith "," (values.map quote) ++ "]"

private def renderCondition (c : Condition) : Input String :=
  quote c.op ++ ":{" ++ joinWith "," (c.entries.map fun (key, values) => quote key ++ ":" ++ stringArray values) ++ "}"

private def renderStatement (s : Statement) : Input String :=
  "{\"Sid\":" ++ quote s.sid ++ ",\"Effect\":\"Allow\",\"Action\":" ++ stringArray (s.actions.map lit)
    ++ ",\"Resource\":" ++ stringArray s.resources
    ++ (if s.conditions.isEmpty then lit "" else ",\"Condition\":{" ++ joinWith "," (s.conditions.map renderCondition) ++ "}")
    ++ "}"

/-- An identity policy: Allow statements only, so what a principal may do is exactly their union. -/
def document (statements : List Statement) : Input String :=
  "{\"Version\":\"2012-10-17\",\"Statement\":[" ++ joinWith "," (statements.map renderStatement) ++ "]}"

/-- A statement grants `action`. Statements name actions exactly (`no_wildcards` in `Cell.Test`
checks that none is a pattern), so membership is the whole story. -/
def Statement.Grants (s : Statement) (action : String) : Prop := action ∈ s.actions

/-- A statement carries condition `op` on `key` with exactly `values`. -/
def Statement.Requires (s : Statement) (op key : String) (values : List (Input String)) : Prop :=
  ∃ c ∈ s.conditions, c.op = op ∧ (key, values) ∈ c.entries

end Cell.Iam
