import Nest.CommitChain
import Nest.Gc
import Nest.Retention

/-! Axioms check: every main theorem uses only the standard axioms (or none). -/

#print axioms Nest.CommitChain.head_recorded
#print axioms Nest.CommitChain.tree
#print axioms Nest.CommitChain.orphan_never_head
#print axioms Nest.CommitChain.head_moves_only_by_cas
#print axioms Nest.CommitChain.replay
#print axioms Nest.CommitChain.idempotent
#print axioms Nest.CommitChain.orphan_parent_unchecked
#print axioms Nest.CommitChain.orphan_after_destroy
#print axioms Nest.Gc.safe
#print axioms Nest.Gc.never_deletes_protected
#print axioms Nest.Gc.b1_unsafe
#print axioms Nest.Gc.b1_pending_lost
#print axioms Nest.Gc.a1_not_vacuous
#print axioms Nest.Retention.safe
#print axioms Nest.Retention.source_present
#print axioms Nest.Retention.load_never_deleting
#print axioms Nest.Retention.unguarded_unsafe
#print axioms Nest.Retention.retention_not_vacuous
