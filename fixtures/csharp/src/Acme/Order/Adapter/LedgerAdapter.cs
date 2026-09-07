using MegaCorp.Ledger;
using Newtonsoft.Json;

namespace Acme.Order.Adapter
{
    /// <summary>
    /// Posts to the ledger and keeps a local trail. `MegaCorp.Ledger` and
    /// `Newtonsoft.Json` are referenced by nothing under the source roots, so
    /// `LedgerClient`, `AuditTrail` and `JsonConverter` are error types: stubs
    /// in the reserved `&lt;unresolved&gt;` module, named as written.
    /// </summary>
    public class LedgerAdapter : LedgerClient
    {
        private readonly AuditTrail trail = new AuditTrail();

        public override void Post(object document)
        {
            trail.Record(document);
            base.Post(document);
        }

        public string Serialize(object document)
        {
            return JsonConvert.SerializeObject(document);
        }
    }

    /// <summary>An unresolved base type in a nested, block-scoped namespace declaration.</summary>
    public class TrailConverter : JsonConverter
    {
    }
}
