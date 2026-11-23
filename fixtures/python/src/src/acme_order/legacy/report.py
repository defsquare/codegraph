# A Python 2 module: no Python 3 parses it; the recovered tree still says what it declares.
import helpers
import ConfigParser


class Report(object):
    def render(self, order):
        print "Order", `order.reference`
        try:
            helpers.check(order)
        except ValueError, error:
            print >>sys.stderr, error


class LegacyError(StandardError):
    pass


def unpack(a, (b, c)):
    return a


MODE = 0660
