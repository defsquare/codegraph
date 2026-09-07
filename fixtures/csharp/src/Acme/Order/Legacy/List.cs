namespace Acme.Order
{
    // A block-scoped namespace nested in another: the inner namespace gets a
    // lexical parent (TChildOf), which a file-scoped or dotted declaration never has.
    namespace Legacy
    {
        /// <summary>A hand-rolled cons list from before System.Collections was allowed here.</summary>
        public class List
        {
            private readonly string head;

            private readonly List? tail;

            public List(string head, List? tail)
            {
                this.head = head;
                this.tail = tail;
            }

            public string Head => head;

            public int Length()
            {
                return tail == null ? 1 : 1 + tail.Length();
            }
        }
    }
}
